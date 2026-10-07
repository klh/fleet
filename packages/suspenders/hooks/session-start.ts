// hooks/session-start.ts — SessionStart control-plane bootstrap.
// Registers the live session, rebinds a closed predecessor when the lineage
// is unambiguous (exactly one closed session in this project still owning
// active work) and source is `resume`, then injects the restart packet
// (SESSION / REBIND / OWNED / READY / INBOX / HEAD). Stdout is injected as
// session context. CLAUDE_FLEET_BOOTSTRAP=0 opts out entirely.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	openStore,
	projectIdentity,
	CAPABILITIES,
	sweepStaleSessions,
} from "./lib/govdb.ts";
import { enrollTopLevel } from "./lib/hook-scripts.ts";
import { checkSessionPolicies } from "./lib/session-policy.ts";

type In = {
	session_id?: string;
	source?: string;
	transcript_path?: string;
	cwd?: string;
};

if (process.env.CLAUDE_FLEET_BOOTSTRAP === "0") process.exit(0);

const raw = await new Response(Bun.stdin.stream()).text();
const input = JSON.parse(raw) as In;
if (!input.session_id) process.exit(0);

let sid = input.session_id;
const src = input.source ?? "startup";
const project = projectIdentity(input.cwd ?? process.cwd());
const now = Date.now();

// Subagent lanes: Claude Code gives a subagent the PARENT's session_id, so
// anything it claims under the raw sid lands on the parent's account (W24 /
// W30, 2026-09-26: the owner's id showed on lanes they never ran). Same
// discriminator as the governor's laneId — register the subagent as its own
// session row and hand it a lane id for claims, checkpoints, and emits.
const laneMatch = (input.transcript_path ?? "").match(
	/\/subagents\/([^/]+?)(?:\.jsonl)?\/?$/,
);
const isSubagent = !!laneMatch;
let lane = laneMatch ? `${sid}#${laneMatch[1]}` : sid;

function pname(p: string): string {
	const parts = p.split("/");
	const last = parts[parts.length - 1].replace(/\.git$/, "");
	return last || parts[parts.length - 2] || p;
}
// CLIs ship in bin/ next to this hook (repo checkout and installed prefix
// share the layout) — resolve there first; fall back to the pre-namespacing
// ~/.claude/bin location for old installs.
const cli = (name: string): string => {
	for (const p of [
		join(import.meta.dir, "bin", name),
		`${process.env.HOME}/.claude/bin/${name}`,
	])
		if (existsSync(p)) return p;
	return `${process.env.HOME}/.claude/bin/${name}`;
};
const WORK = cli("work.ts");
const COORD = cli("coord.ts");

const RULES =
	`RULES: Work Graph (bun ${WORK}) is authoritative — ` +
	"continue OWNED before taking new; own an item (work take) before code " +
	"work; never reconstruct mutable state from Markdown; parallelizable " +
	"work gets work split. Stuck or need a colleague's context: " +
	"coord consult/who-knows (questions, never ownership). Who-is-working: " +
	"query the plane (sessions + claims, coord fleet) — never /tmp files. " +
	"Fleet lessons live in facts — coord fact list (lesson.*) before " +
	"re-deriving painful knowledge; set lesson.<topic> when you learn " +
	"something another lane will need. " +
	"Between items: coord subscribe (W303) keeps your inbox PUSHED — " +
	"one persistent connection, never exit it; session bootstrap opens it " +
	"for you. Do NOT poll with repeated CLI probes. If READY work matches " +
	"your capabilities, take it yourself — don't wait for dispatch; " +
	"checkpoint each landed " +
	"milestone (work done --sha / capsule) so preemption stays possible. " +
	"Decisions: a decision held only in your context is invisible to the " +
	"fleet and the owner — emit it (coord emit NEED_DECISION --to " +
	'<coordinator-or-own-sid> --note "question + options" --as <sid>) ' +
	"the moment you hold one; the fleet board surfaces it for the human. " +
	"Narration: terse, not verbose, as your own plain response text — " +
	"NEVER a shell echo/tool call (that renders as a visible tool-" +
	"invocation block, not narration). The templates are the ENTIRE " +
	"narration — no parenthetical asides, no extra sentence tacked on. " +
	"Use coord subscribe --as <sid> (W303, live WebSocket push) over " +
	"coord wait's poll/relaunch loop — one persistent connection, never " +
	"exits, no relaunching, ever. " +
	"Routine untargeted events (BROADCAST, work.landed, knowledge.settled) " +
	"get no commentary; a consult addressed to you is `consult: [C##] " +
	"<asker> asks ...` / `consult: [C##] replying ...`; a fleet-wide " +
	"consult is `consult: fleet asks, ...` / `consult: fleet, no " +
	"knowledge, didn't reply` or `...details forwarded` — see AGENTS.md.";

// top-level sessions are full agent runtimes — advertise the complete
// capability set so capability-gated work stays takeable by them (lanes
// inherit their caps from the parent via coord bootstrap --parent)
const CAPS = CAPABILITIES.join(",");
// actor attribution: stamp the settings default_actor (config-over-code —
// suspenders-board.json) into every bootstrapped session, never clobbering
// an explicit actor
const actorDefault = (() => {
	try {
		return (
			JSON.parse(
				readFileSync(
					join(
						process.env.HOME ?? "",
						".claude/local-llm/suspenders-board.json",
					),
					"utf8",
				),
			).default_actor ?? null
		);
	} catch {
		return null;
	}
})();
const UPSERT =
	"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path, actor) " +
	"VALUES (?, ?, 'worker', ?, NULL, ?, ?, 'RUNNING', ?, ?, ?) " +
	"ON CONFLICT(sid) DO UPDATE SET project = excluded.project, parent_sid = COALESCE(excluded.parent_sid, CASE WHEN (SELECT project FROM sessions parent WHERE parent.sid = sessions.parent_sid) = excluded.project THEN sessions.parent_sid END), hb = excluded.hb, state = 'RUNNING', capabilities = COALESCE(excluded.capabilities, sessions.capabilities), transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path), actor = CASE WHEN sessions.actor IS NULL OR sessions.actor = '' THEN excluded.actor ELSE sessions.actor END";

const DEAD_SQL =
	"SELECT s.sid FROM sessions s WHERE s.project = ? AND s.state = 'CLOSED' " +
	"AND EXISTS(SELECT 1 FROM work_items w WHERE w.owner_sid = s.sid " +
	"AND w.project = s.project AND w.state NOT IN ('DONE','CANCELLED','SUPERSEDED','FAILED'))";

const OWNED_SQL =
	"SELECT id, title, state FROM work_items " +
	"WHERE project = ? AND owner_sid = ? " +
	"AND state NOT IN ('DONE','CANCELLED','SUPERSEDED','FAILED') ORDER BY id";

const db = openStore();
// The executor may mint a different SDK session ID. Only a registered lane
// with a current claim in this exact worktree can supply the canonical ID.
const declaredSid = process.env.SUSPENDERS_SID;
const identityProtocol = process.env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
if (identityProtocol !== undefined && identityProtocol !== "canonical-v1") {
	console.log("SESSION IDENTITY REFUSED: unsupported identity protocol.");
	db.close();
	process.exit(1);
}
if (identityProtocol === "canonical-v1") {
	try {
		if (!declaredSid) throw new Error("canonical lane ID missing");
		const registered = db
			.query("SELECT project, worktree, parent_sid FROM sessions WHERE sid = ?")
			.get(declaredSid) as {
			project: string;
			worktree: string | null;
			parent_sid: string | null;
		} | null;
		const claimed = db
			.query(
				"SELECT 1 FROM work_items WHERE project = ? AND owner_sid = ? AND state IN ('CLAIMED','RUNNING')",
			)
			.get(project, declaredSid);
		if (!registered || registered.project !== project || !claimed || !input.cwd)
			throw new Error(
				"declared lane lacks matching project, claim or worktree",
			);
		// Older live controllers did not register worktree metadata. Retain
		// their SDK identity until a supported bootstrap supplies strong binding.
		if (registered.worktree !== null) {
			if (realpathSync(registered.worktree) !== realpathSync(input.cwd))
				throw new Error("declared lane belongs to another worktree");
			if (
				registered.parent_sid &&
				!db
					.query("SELECT 1 FROM sessions WHERE sid = ? AND project = ?")
					.get(registered.parent_sid, project)
			)
				throw new Error("declared lane parent is outside this project");
			sid = declaredSid;
			lane = laneMatch ? `${sid}#${laneMatch[1]}` : sid;
		}
	} catch {
		console.log(
			"SESSION IDENTITY REFUSED: declared lane lacks matching project, active claim or worktree.",
		);
		db.close();
		process.exit(1);
	}
}
db.query(UPSERT).run(
	lane,
	project,
	isSubagent ? sid : null,
	now,
	now,
	CAPS,
	input.transcript_path ?? null,
	actorDefault,
);
const out = [
	isSubagent
		? `SUBAGENT LANE ${lane.slice(0, 24)}  project=${pname(project)}`
		: `SESSION ${sid.slice(0, 8)}  project=${pname(project)}`,
];

// WS-first inbox (W303, owner directive 2026-10-05): bootstrap opens the
// live subscribe ONCE per session — agents never poll the plane. Idempotent:
// a live subscribe for this lane id is detected and left alone.
{
	const SUB_LOG = `${process.env.HOME}/.claude-insights/coord-subscribe-${lane}.log`;
	const live = Bun.spawnSync([
		"/usr/bin/pgrep",
		"-f",
		`coord[.]ts subscribe --as ${lane}$`,
	]);
	if (live.exitCode !== 0) {
		const cmd =
			"nohup bun " +
			import.meta.dir +
			"/bin/coord.ts subscribe --as " +
			lane +
			" >> " +
			SUB_LOG +
			" 2>&1 &";
		Bun.spawn(["/bin/sh", "-c", cmd], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		out.push(
			"WS inbox live: coord subscribe --as " +
				lane +
				" (events push; never poll)",
		);
	}
}

// automagic hygiene: every bootstrap sweeps stale sessions fleet-wide —
// sweeps read THIS host's transcripts, so they ride db.local only (W92 seam)
const sweptN = db.local ? sweepStaleSessions(db as Database) : 0;
if (sweptN)
	out.push(
		`SWEPT ${sweptN} stale session(s) — hb-stale + transcript-dead (coordinator/waiting kept)`,
	);
if (isSubagent) {
	out.push(
		`You share the parent's session id — claim and checkpoint as the lane id instead: ` +
			`work take/done --as ${lane}, coord emit --as ${lane}. Raw-sid claims land on the parent's account.`,
	);
}

// lineage: only `resume` may rebind — startup/clear/compact never touch
// ownership. 0 closed owners → fresh start; 1 → deterministic rebind;
// >1 → escalate, never guess. Subagent lanes never rebind: they are not
// continuations of anything.
const dead =
	src === "resume" && !isSubagent
		? (db.query(DEAD_SQL).all(project) as { sid: string }[])
		: [];
if (dead.length === 1 && dead[0].sid !== sid) {
	const p = Bun.spawnSync(
		["bun", COORD, "resume-session", "--as", sid, "--from", dead[0].sid],
		{
			stdout: "pipe",
		},
	);
	out.push(`REBIND ${new TextDecoder().decode(p.stdout).trim()}`);
} else if (dead.length > 1) {
	const ids = dead.map((d) => d.sid.slice(0, 8)).join(", ");
	out.push(`LINEAGE AMBIGUOUS: ${ids} — resolve with coord resume-session`);
}

// governance mode: read once — feeds the rules line AND the W422.17.1
// session enrollment decision.
const govMode =
	(
		db
			.query("SELECT value FROM facts WHERE key = 'fleet.governance'")
			.get() as { value: string } | null
	)?.value === "solo"
		? "solo"
		: "strict";

const mine = db.query(OWNED_SQL).all(project, lane) as {
	id: string;
	title: string;
	state: string;
}[];
const readyN = (
	db
		.query(
			"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'",
		)
		.get(project) as { n: number }
).n;
const cur = db
	.query("SELECT event_id FROM cursors WHERE sid = ?")
	.get(lane) as { event_id: number } | null;
const inbox = (
	db
		.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?")
		.get(lane, cur?.event_id ?? 0) as { n: number }
).n;
const head = (
	db.query("SELECT value FROM facts WHERE key = 'integration.head'").get() as {
		value: string;
	} | null
)?.value;

if (mine.length || inbox > 0 || readyN > 0 || head) {
	const owned = mine
		.map((w) => `${w.id}[${w.state}] ${w.title.slice(0, 40)}`)
		.join(", ");
	out.push(
		`OWNED ${mine.length}${owned ? `: ${owned}` : ""}  READY ${readyN}  INBOX ${inbox}${head ? `  head=${head.slice(0, 7)}` : ""}`,
	);
	out.push(RULES);
	// W422.17 (owner ruling 2026-10-06): the governance mode renders as one
	// rules line — lanes know the probe-false contract before dispatching.
	out.push(
		govMode === "solo"
			? "GOVERNANCE: solo — dispatch may ride belt-direct when the buckle front is unreachable (restore strict: coord governance strict)"
			: "GOVERNANCE: strict — lanes dispatch only through buckle (probe-false = refusal; solo mode via: coord governance solo)",
	);
}

// W422.17.1 interactive-session enrollment — top-level sessions mint (or
// reuse) a per-session bksk_ key and take the 0600 settings env file (the
// lane pattern generalized, 5efcf83). Subagents inherit the parent's
// enrollment. Sessions cannot be refused: every buckle miss folds
// belt-direct with the loud, mode-rendered note. Degrades silently —
// bootstrap must never break on enrollment.
if (!isSubagent && input.cwd) {
	try {
		const note = await enrollTopLevel({
			hookDir: import.meta.dir,
			sid: lane,
			cwd: input.cwd,
			govMode,
		});
		if (note) out.push(note);
	} catch {
		// degrade: the session rides belt-direct like an unreachable front
	}
}

// fleet notices: inject unseen `coord broadcast` notes — each session sees
// each notice exactly once (per-session watermark in facts)
{
	const bl = db
		.query("SELECT value FROM facts WHERE key = 'broadcast.latest'")
		.get() as { value: string } | null;
	if (bl) {
		try {
			const b = JSON.parse(bl.value) as {
				id: string;
				ts: number;
				note: string;
			};
			const seen = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`broadcast.seen.${sid}`) as { value: string } | null;
			if (b.ts > Number(seen?.value ?? 0)) {
				out.push(
					`FLEET NOTICE (${new Date(b.ts).toISOString().slice(0, 16).replace("T", " ")} UTC): ${b.note}`,
				);
				db.query(
					"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
				).run(`broadcast.seen.${sid}`, String(b.ts), now);
			}
		} catch {}
	}
}

// fleet lessons: facts under the lesson.* namespace are the curriculum —
// pushed at bootstrap (once per session, watermark like broadcasts) because
// pull-only knowledge never gets pulled. Values are truncated; the full note
// is one coord fact get away.
{
	const wm = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lesson.seen.${sid}`) as { value: string } | null;
	const rows = db
		.query(
			"SELECT key, value, ts FROM facts WHERE key LIKE 'lesson.%' AND key NOT LIKE 'lesson.seen.%' AND ts > ? ORDER BY ts LIMIT 5",
		)
		.all(Number(wm?.value ?? 0)) as {
		key: string;
		value: string;
		ts: number;
	}[];
	if (rows.length) {
		for (const r of rows) {
			const v =
				r.value.length > 200
					? `${r.value.slice(0, 200)}… (coord fact get ${r.key})`
					: r.value;
			out.push(`LESSON ${r.key.slice("lesson.".length)}: ${v}`);
		}
		db.query(
			"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
		).run(
			`lesson.seen.${sid}`,
			String(Math.max(...rows.map((r) => r.ts))),
			now,
		);
	}
}

// legacy-ledger notice: known operational-ledger names, unmarked = old habit
// may still treat them as live. One terse line, first match only. Deterministic
// filename check only — no content classification, no auto-migration.
const LEDGERS = [
	"MASTER-TASK-LEDGER.md",
	"TODO.md",
	"TASKS.md",
	"BACKLOG.md",
	"PROGRESS.md",
	"STATUS.md",
	"ROADMAP.md",
];
outer: for (const dir of [".", "docs", "docs/design"]) {
	for (const name of LEDGERS) {
		const p = `${process.cwd()}/${dir === "." ? "" : `${dir}/`}${name}`;
		try {
			if (
				!existsSync(p) ||
				readFileSync(p, "utf8").includes("HISTORICAL / DESIGN RECORD")
			)
				continue;
			out.push(
				`LEGACY LEDGER ${dir === "." ? "" : `${dir}/`}${name} — operational state belongs in the Work Graph (register items, add the HISTORICAL banner); never append progress there`,
			);
			break outer;
		} catch {}
	}
}
if (input.cwd && !isSubagent) {
	try {
		const configPath = process.env.SUSPENDERS_REPO_POLICY_CONFIG;
		if (
			configPath !== undefined &&
			(!isAbsolute(configPath) || !existsSync(configPath))
		)
			throw new Error(
				"policy configuration override must exist at an absolute path",
			);
		out.push(
			...(await checkSessionPolicies({
				db,
				sid: lane,
				project,
				repo: input.cwd,
				configPath,
			})),
		);
	} catch {
		out.push(
			"POLICY CHECK UNAVAILABLE: invalid runtime configuration; policy compliance is unknown.",
		);
	}
}
console.log(out.join("\n"));
