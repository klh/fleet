import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
	type BriefWeight,
	buckleLaneTokens,
	type LaneTokens,
	measureBriefWeight,
} from "../../scripts/lib/brief-weight.ts";
import { capsuleProjectTag } from "../lib/capsule-fence.ts";
import { type LaneVerdict, verdictBySid } from "../lib/lane-liveness.ts";
import { loadLaneRegistry } from "../lib/lane-registry.ts";
import {
	type ItemSpend,
	itemSpend,
	laneSpendRows,
	resolveBuckleDb,
} from "../lib/lane-spend.ts";
import { hbFresh } from "../lib/reclaim-liveness.ts";
import { renameSession } from "../lib/session-rename.ts";
import { attachSubscribe } from "../lib/subscribe-attach.ts";
import { ensureCompletionIdentityMigration } from "../lib/work-completion-record.ts";
import {
	buildReportTable,
	reportRows,
	reportTableLinkOpts,
} from "../lib/work-report.ts";
import { claimWindows } from "../lib/work-timing.ts";
import { ageOf, formatEventLine } from "./bus.ts";
import { listLiveTargets } from "./addressing.ts";
import { cmdBind, cmdEnroll, cmdVerify } from "./identity.ts";
import type { Database, Ev } from "./shared.ts";
// hooks/coord/fleet.ts — fleet-wide reads: bootstrap, fleet, metrics, doctor-session, diff (W157 command modules).
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.
import {
	amber,
	arg,
	CAPABILITIES,
	cyan,
	db,
	die,
	dim,
	green,
	projectIdentity,
	realpathSync,
	red,
	resolve,
	sweepStaleSessions,
	tagNameOf,
	tokenUsage,
	workTiming,
} from "./shared.ts";

export async function cmdBootstrap(_rest: string[]): Promise<void> {
	// the session-start ritual: identity + owned work + ready pool + inbox,
	// so no session reconstructs operational state from Markdown
	const as =
		arg("--as") ??
		die(
			"usage: bootstrap --as <sid> [--role r] [--parent sid] [--worktree w] [--caps shell,fs,...] [--actor id] [--tags json] [--name label]",
		);
	// project identity is always derived (projectIdentity) — no --project
	// override, it would let sessions fragment the graph by hand
	const project = projectIdentity();
	const parent = arg("--parent");
	const worktree = arg("--worktree");
	const existing = db
		.query("SELECT project,parent_sid,worktree FROM sessions WHERE sid=?")
		.get(as) as {
		project: string;
		parent_sid: string | null;
		worktree: string | null;
	} | null;
	if ((parent || worktree) && existing && existing.project !== project)
		die("bootstrap metadata cannot cross project identity");
	if (parent) {
		const registered = db
			.query("SELECT project,state FROM sessions WHERE sid=?")
			.get(parent) as { project: string; state: string } | null;
		if (
			parent === as ||
			!registered ||
			registered.project !== project ||
			registered.state !== "RUNNING"
		)
			die("bootstrap parent must be a registered live session in this project");
		if (existing?.parent_sid && existing.parent_sid !== parent)
			die("bootstrap cannot reassign an existing parent");
	}
	const canonicalWorktree = worktree ? realpathSync(resolve(worktree)) : null;
	if (canonicalWorktree && projectIdentity(canonicalWorktree) !== project)
		die("bootstrap worktree must belong to this project");
	if (
		canonicalWorktree &&
		existing?.worktree &&
		realpathSync(existing.worktree) !== canonicalWorktree
	)
		die("bootstrap cannot reassign an existing worktree");
	const role = arg("--role") ?? "worker";
	// capability-aware dispatch (v2): --caps csv registers what this agent type
	// offers; lanes inherit the parent's capabilities unless overridden — a
	// NO-SHELL agent type can then never take shell-requiring work twice
	let caps: string | null = arg("--caps") ?? null;
	if (caps) {
		const bad = caps.split(",").filter((c) => !CAPABILITIES.includes(c.trim()));
		if (bad.length)
			die(
				`unknown capability: ${bad.join(",")} — vocabulary: ${CAPABILITIES.join(",")}`,
			);
		caps = caps
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean)
			.join(",");
	} else {
		const parentSid = arg("--parent");
		if (parentSid)
			caps =
				(
					db
						.query("SELECT capabilities FROM sessions WHERE sid = ?")
						.get(parentSid) as { capabilities: string | null } | null
				)?.capabilities ?? null;
	}
	// W127 usage attribution: actor = user/license id, tags = JSON ({team,
	// department, ...}). COALESCE on conflict keeps the first stamp across
	// re-bootstraps, same trust class as capabilities.
	const actor: string | null = arg("--actor") ?? null;
	let tags: string | null = arg("--tags") ?? null;
	if (tags) {
		try {
			tags = JSON.stringify(JSON.parse(tags));
		} catch {
			die("--tags must be valid JSON");
		}
	}
	// W293 session-name bridge: --name merges into the tags JSON (`{ name }`) —
	// the user-facing lane label `coord fleet` and the board render. A user
	// rename is the freshest identity, so a re-bootstrap RENAMES (the name key
	// is last-stamp-wins); every other tag key keeps its first-stamp value and
	// an explicit --name beats a name embedded in --tags.
	const name = arg("--name");
	if (name != null) {
		const merged: Record<string, unknown> = {};
		try {
			const prev = (
				db.query("SELECT tags FROM sessions WHERE sid = ?").get(as) as {
					tags: string | null;
				} | null
			)?.tags;
			if (prev) Object.assign(merged, JSON.parse(prev) as object);
		} catch {}
		if (tags) Object.assign(merged, JSON.parse(tags) as object);
		merged.name = name;
		tags = JSON.stringify(merged);
	}
	// liveness sweeps read THIS host's transcript tree — a remote lane's view
	// would close live sessions it cannot see; sweeping stays a host concern
	if (db.local) sweepStaleSessions(db as Database);
	// Bind provenance atomically. Earlier reads improve errors, but cannot
	// authorize a competing writer that registered this SID in the meantime.
	const binding = db
		.query(
			`INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, actor, tags)
		SELECT ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?
		WHERE ? IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE sid=? AND project=? AND state='RUNNING')
		ON CONFLICT(sid) DO UPDATE SET role = excluded.role, parent_sid = COALESCE(sessions.parent_sid,excluded.parent_sid), worktree = COALESCE(sessions.worktree,excluded.worktree), hb = excluded.hb, capabilities = COALESCE(excluded.capabilities, sessions.capabilities), actor = COALESCE(excluded.actor, sessions.actor), tags = COALESCE(excluded.tags, sessions.tags)
		WHERE sessions.project=excluded.project
		AND (sessions.parent_sid IS NULL OR excluded.parent_sid IS NULL OR sessions.parent_sid=excluded.parent_sid)
		AND (sessions.worktree IS NULL OR excluded.worktree IS NULL OR sessions.worktree=excluded.worktree)`,
		)
		.run(
			as,
			project,
			role,
			parent,
			canonicalWorktree,
			Date.now(),
			Date.now(),
			caps,
			actor,
			tags,
			parent,
			parent,
			project,
		);
	if (!binding.changes)
		die(
			"bootstrap identity binding changed concurrently or conflicts with registered provenance",
		);
	// Every remotely bound session bootstrap attaches its push inbox. A local
	// SQLite binding has no WebSocket server to attach to.
	if (!db.local) attachSubscribe(as);
	const mine = db
		.query(
			"SELECT id, title, state FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED') ORDER BY id",
		)
		.all(project, as) as { id: string; title: string; state: string }[];
	const readyN = (
		db
			.query(
				"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'",
			)
			.get(project) as { n: number }
	).n;
	const ncur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	const inbox = (
		db
			.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?")
			.get(as, ncur) as { n: number }
	).n;
	const head = (
		db
			.query("SELECT value FROM facts WHERE key = 'integration.head'")
			.get() as { value: string } | null
	)?.value;
	const pname = projectDisplayName(project);
	console.log(`SESSION ${as.slice(0, 8)}  project=${pname}  role=${role}`);
	console.log(
		`OWNED ${mine.length}${mine.length ? `: ${mine.map((w) => `${w.id} ${w.state}`).join(", ")}` : ""}  READY ${readyN}  INBOX ${inbox}${head ? `  head=${head.slice(0, 7)}` : ""}`,
	);
	for (const w of mine)
		console.log(`  ${cyan(w.id)} ${dim(w.state)} ${w.title.slice(0, 60)}`);
}

// W930: the ONE shared rename verb — `coord rename --as <sid> <name>`. Sets
// sessions.tags `name` (the W293 key every @name resolution reads) through
// lib/session-rename renameSession, so verb and stop-gate sync share the
// duplicate rule (live same-project slug collision: refuse without --force).
export async function cmdRename(_rest: string[]): Promise<void> {
	const as = arg("--as") ?? die("usage: rename --as <sid> <name> [--force]");
	// positional name: first raw token that is neither a flag nor a flag value
	const known = new Set(["--as", "--name"]);
	let name = arg("--name");
	for (let i = 0; !name && i < _rest.length; i++) {
		const t = _rest[i];
		if (t === "--force") continue;
		if (known.has(t)) i++;
		else if (!t.startsWith("--")) name = t;
	}
	if (!name) die("usage: rename --as <sid> <name> [--force]");
	const r = renameSession(db, as, name, { force: _rest.includes("--force") });
	if (!r.ok) {
		if (r.reason === "duplicate")
			die(
				`duplicate name ${JSON.stringify(name)} — held by ${r.holder?.slice(0, 8)} (live, same project); --force overrides`,
			);
		if (r.reason === "no-session") die(`no session ${as}`);
		if (r.reason === "not-running")
			die(`session ${as.slice(0, 8)} is not RUNNING — rename refused`);
		die("empty name refused — usage: rename --as <sid> <name>");
	}
	console.log(
		`RENAMED ${as.slice(0, 8)}${r.previous ? ` (${r.previous} →)` : ""} ${r.name}`,
	);
}

/** display name of a project key: basename with a trailing .git stripped
 *  (…/fleet/.git → fleet; bare keys pass through). */
export const projectDisplayName = (project: string): string =>
	project
		.split("/")
		.pop()
		?.replace(/\.git$/, "") ||
	project.split("/").slice(-2, -1).pop() ||
	project;

/** W1242 --project <path|name>: a path (contains "/", or "." / "..") resolves
 *  through the ONE identity resolver (projectIdentity — the coord project
 *  resolution every other verb rides); a bare name matches the graph's
 *  distinct project keys by display name. Misses die with the known set. */
export const resolveProjectArg = (ref: string): string => {
	if (ref.includes("/") || ref === "." || ref === "..") {
		const p = resolve(ref);
		if (!existsSync(p)) die(`fleet --project: no such path: ${ref}`);
		return projectIdentity(p);
	}
	const byName = new Map<string, string[]>();
	for (const r of db.query("SELECT DISTINCT project FROM work_items").all() as {
		project: string;
	}[]) {
		const k = projectDisplayName(r.project);
		byName.set(k, [...(byName.get(k) ?? []), r.project]);
	}
	const hits = byName.get(ref);
	if (hits?.length === 1) return hits[0];
	if (hits)
		die(
			`fleet --project: ambiguous name ${JSON.stringify(ref)} — candidates: ${hits.join(", ")}`,
		);
	die(
		`fleet --project: no project ${JSON.stringify(ref)} — known: ${[...byName.keys()].sort().join(", ") || "(none)"}`,
	);
};

export async function cmdFleet(_rest: string[]): Promise<void> {
	// W1242 --project <path|name> filter: resolved up front so a bad ref dies
	// loud before either face renders; default = the cwd project identity.
	const projArg = arg("--project");
	const project =
		projArg == null ? projectIdentity() : resolveProjectArg(projArg);
	// one-line fleet projection for a terminal pane (the Desktop panel
	// projection lives in subagent-statusline.ts; the CLI inline rows are
	// harness-owned and ignore it)
	const crows = db
		.query("SELECT sid, scope, intent FROM claims ORDER BY sid, scope")
		.all() as { sid: string; scope: string; intent: string | null }[];
	// File leases, work ownership and registered peers are distinct sources.
	// Reuse the direct-addressing live projection so discovery cannot hide a
	// registered worker merely because it has not acquired a file lease yet.
	const targets = listLiveTargets();
	const targetSids = new Set(targets.map((target) => target.sid));
	const work = db
		.query(
			"SELECT w.owner_sid AS sid, w.project, w.id, w.title, w.state FROM work_items w LEFT JOIN sessions s ON s.sid = w.owner_sid WHERE w.owner_sid IS NOT NULL AND w.state IN ('CLAIMED','RUNNING','ORPHANED') AND (s.sid IS NULL OR s.project = w.project) ORDER BY w.project,w.id",
		)
		.all() as {
		sid: string;
		project: string;
		id: string;
		title: string;
		state: string;
	}[];
	const sessions = new Map(
		(
			db.query("SELECT sid,state FROM sessions").all() as {
				sid: string;
				state: string;
			}[]
		).map((session) => [session.sid, session.state]),
	);
	const lanes = [
		...new Set([
			...crows.map((claim) => claim.sid),
			...work.map((item) => item.sid),
			...targetSids,
		]),
	].sort();
	// W652.1: liveness delegates to the shared verdict (lib/lane-liveness.ts)
	// — state glyphs say what a lane CLAIMS (lane.<sid>.state facts); only
	// positive death evidence flips the glyph to ×. Unknown keeps the state
	// glyph (lookup failure is never death — monitor doctrine W51).
	const verdicts = verdictBySid(lanes, loadLaneRegistry(process.cwd()));
	// W378 fleet honesty: a claimant the registry can't join (manual takes,
	// pruned rows) carries no process evidence — the W610 claimant probe
	// vouches from the governor heartbeat alone, everything else reads
	// unknown. An unevidenced claim never paints ▶ again (the W378 board
	// lie: 30 running-markers, 1 real lane).
	const verdictOf = (sid: string): LaneVerdict =>
		verdicts.get(sid) ??
		(targetSids.has(sid) || hbFresh(db, sid) ? "alive" : "unknown");
	const states = db
		.query("SELECT key, value FROM facts WHERE key LIKE 'lane.%.state'")
		.all() as { key: string; value: string }[];
	const byKey = new Map(states.map((s) => [s.key, s.value]));
	const names = new Map<string, string>();
	for (const c of crows) {
		if (c.intent && !names.has(c.sid))
			names.set(
				c.sid,
				c.intent.length > 14 ? `${c.intent.slice(0, 13)}…` : c.intent,
			);
	}
	for (const item of work)
		if (!names.has(item.sid)) names.set(item.sid, `${item.id} ${item.title}`);
	// W293 session-name bridge: a user-facing name (sessions.tags JSON, stamped
	// by `coord bootstrap --name`) leads the lane label with the short sid next
	// to it; unnamed lanes keep the claim-intent → sid fallback.
	const sessionNames = new Map<string, string>();
	for (const l of lanes) {
		const n = tagNameOf(
			(
				db.query("SELECT tags FROM sessions WHERE sid = ?").get(l) as {
					tags: string | null;
				} | null
			)?.tags,
		);
		if (n) sessionNames.set(l, n);
	}
	const trunc = (s: string): string =>
		s.length > 24 ? `${s.slice(0, 23)}…` : s;
	const head = (
		db
			.query("SELECT value FROM facts WHERE key = 'integration.head'")
			.get() as { value: string } | null
	)?.value;
	// W522 fleet-watch feed — the same projection, machine-readable: lane
	// state facts + session names + claim intents, no ANSI. Undefined state
	// facts mean a fresh claim (text path paints ▶ too).
	if (_rest.includes("--json")) {
		console.log(
			JSON.stringify({
				head: head?.slice(0, 7) ?? null,
				lanes: lanes.map((l) => ({
					sid: l,
					name: sessionNames.get(l) ?? null,
					intent: names.get(l) ?? null,
					state: byKey.get(`lane.${l}.state`) ?? sessions.get(l) ?? "UNKNOWN",
					sessionState: sessions.get(l) ?? null,
					fileClaims: crows
						.filter((claim) => claim.sid === l)
						.map(({ scope, intent }) => ({ scope, intent })),
					workItems: work
						.filter((item) => item.sid === l)
						.map(({ project, id, title, state }) => ({
							project,
							id,
							title,
							state,
						})),
					verdict: verdictOf(l),
					live: verdictOf(l) === "alive",
				})),
			}),
		);
		return;
	}
	const parts = lanes.map((l) => {
		const st = byKey.get(`lane.${l}.state`);
		// W652.1: positive death flips ×. W378: unknown is its own glyph — an
		// unevidenced claimant reads ? (never a running marker); only evidence
		// (registry verdict or fresh heartbeat) paints ▶.
		const v = verdictOf(l);
		const g =
			v === "dead"
				? red("×")
				: v === "unknown"
					? dim("?")
					: st === "PAUSE_REQUESTED"
						? amber("◐")
						: st === "PAUSED"
							? amber("⏸")
							: st === "RESUME_READY"
								? cyan("↻")
								: st === "BLOCKED"
									? red("⚠")
									: green("▶");
		const nm = sessionNames.get(l);
		return `${g} ${nm ? `${trunc(nm)} ${dim(`(${l.slice(0, 8)})`)}` : dim(names.get(l) ?? l.slice(0, 8))} ${dim(`[sid=${l}]`)}`;
	});
	// W1242: the human face is the ONE supervisor table — the W892 renderer
	// (hooks/lib/work-report.ts, the same source `work report` rides), so the
	// CLI face cannot drift from the board/brief faces. --project selects the
	// graph (resolved up front, above); the lane projection line (W378
	// honesty glyphs) stays beneath it; --json above stays the machine face.
	// Attribution-absent columns degrade inside the shared renderer.
	const { rows } = reportRows(db as unknown as Database, project, {
		now: Date.now(),
	});
	if (head) console.log(dim(`HEAD ${head.slice(0, 7)}`));
	console.log(buildReportTable(rows, reportTableLinkOpts()));
	console.log(parts.join("  ") || dim("(no claimed lanes)"));
}

export async function cmdMetrics(rest: string[]): Promise<void> {
	// W3 — control-plane metrics: did the fleet actually move fast? Runs per
	// role, per-item wall vs agent time (W15 derivation in govdb.ts), lane
	// dwell in WAIT_RATE / WAIT_DED / PAUSED, conflicts, repairs. Terse table
	// + a facts snapshot fact (metrics.snapshot.<date>) for trend diffing.
	const known = new Set(["--days"]);
	const projArgs: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		projArgs.push(rest[i]);
	}
	const now = Date.now();
	const days = Number(arg("--days") ?? 7);
	const cut = now - days * 86_400_000;
	let project = projectIdentity();
	if (projArgs[0]) {
		const g = Bun.spawnSync(
			["git", "-C", projArgs[0], "rev-parse", "--git-common-dir"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const dir =
			g.exitCode === 0 ? new TextDecoder().decode(g.stdout).trim() : "";
		project = dir
			? realpathSync(resolve(projArgs[0], dir))
			: realpathSync(projArgs[0]);
	}
	const name = projectDisplayName(project);
	const runs = db
		.query(
			"SELECT role, COUNT(*) AS n FROM sessions WHERE project = ? AND started_at >= ? GROUP BY role ORDER BY n DESC",
		)
		.all(project, cut) as { role: string; n: number }[];
	console.log(`METRICS ${name} (last ${days}d)`);
	console.log(
		`  runs: ${runs.reduce((a, r) => a + r.n, 0)}${runs.length ? ` (${runs.map((r) => `${r.n} ${r.role}`).join(", ")})` : ""}`,
	);
	// per-item wall/agent time — the W15 derivation, straight off the bus
	const timing = workTiming(db as Database, project, now).filter(
		(t) => t.lastEvent >= cut || (!t.done && !t.failed),
	);
	const doneItems = timing.filter((t) => t.done && t.firstClaim > 0); // lane work: claimed → done (auto-rollups excluded)
	const openN = timing.filter((t) => !t.done && !t.failed).length;
	const med = (xs: number[]): number =>
		xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
	const fmt = (ms: number): string => {
		if (!ms) return "—";
		const m = Math.round(ms / 60_000);
		return m >= 60
			? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
			: `${m}m`;
	};
	console.log(
		`  items: ${doneItems.length} done, ${openN} open — median done item: wall ${fmt(med(doneItems.map((t) => t.wallMs)))}, agent ${fmt(med(doneItems.map((t) => t.agentMs)))}`,
	);
	// W24 — usage per task: windowed transcript tokens per item. Approximation —
	// attribution is by claim-window overlap in time, not causality (a session
	// working several items serially shares its transcript across windows).
	const tokens = tokenUsage(db as Database, project, now);
	// W635 — cost per DONE item: buckle-ledger lane spend joined to claim
	// windows (lib/lane-spend.ts). Window attribution like W24 tokens; a
	// missing/unreadable ledger yields null — no cost section, never blocks.
	const ledger = resolveBuckleDb();
	let costs: Map<string, ItemSpend> | null = null;
	if (ledger) {
		try {
			costs = itemSpend(
				laneSpendRows(ledger, `${new Date(cut).toISOString().slice(0, 13)}:00`),
				claimWindows(db as Database, project, now).windows,
			);
		} catch {
			costs = null; // unreadable ledger — fail soft
		}
	}
	const shown = [...timing].sort((a, b) => b.wallMs - a.wallMs).slice(0, 8);
	const fmtTok = (n: number): string =>
		n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${Math.round(n / 1e3)}k`
				: `${n}`;
	const totalTok = (c: ItemSpend): number => c.in + c.out + c.cacheR + c.cacheC;
	let sumIn = 0;
	let sumOut = 0;
	let tokN = 0;
	for (const t of shown) {
		const k = tokens.get(t.work);
		if (k) {
			tokN++;
			sumIn += k.in + k.cacheR + k.cacheC;
			sumOut += k.out;
		}
		const tok = k ? fmtTok(k.in + k.out + k.cacheR + k.cacheC) : "-";
		const c = costs?.get(t.work);
		const spend =
			c && c.in + c.out + c.cacheR + c.cacheC > 0
				? fmtTok(c.in + c.out + c.cacheR + c.cacheC)
				: "-";
		console.log(
			`    ${cyan(t.work.padEnd(8))} wall ${fmt(t.wallMs).padStart(6)}  agent ${fmt(t.agentMs).padStart(6)}  tok ${tok.padStart(6)}  spend ${spend.padStart(6)}  ${t.claims} claim${t.claims === 1 ? "" : "s"}${t.failed ? red(" FAILED") : t.done ? "" : amber(" open")}`,
		);
	}
	if (shown.length)
		console.log(
			`  tokens (approx, window-attributed): in ${tokN ? fmtTok(sumIn) : "-"} · out ${tokN ? fmtTok(sumOut) : "-"} across ${shown.length} shown items`,
		);
	// W635 cost summary: median spend per DONE item + per-class (model_group)
	// split — the dispatch-mix decision metric. Tokens, not $: pricing stays
	// in machine config (config-over-code).
	let costStats: {
		costed: number;
		median: number;
		groups: [string, number][];
	} | null = null;
	if (costs) {
		const doneCosts = doneItems
			.map((t) => costs?.get(t.work))
			.filter((c): c is ItemSpend => c != null);
		const costed = doneCosts.filter((c) => totalTok(c) > 0);
		if (costed.length) {
			const byGroup = new Map<string, number>();
			for (const c of costed)
				for (const [g, v] of c.groups)
					byGroup.set(
						g,
						(byGroup.get(g) ?? 0) + v.in + v.out + v.cacheR + v.cacheC,
					);
			costStats = {
				costed: costed.length,
				median: med(costed.map(totalTok)),
				groups: [...byGroup.entries()].sort((a, b) => b[1] - a[1]),
			};
			console.log(
				`  cost/item (buckle ledger, window-attributed): ${costStats.costed}/${doneItems.length} done items costed — median ${fmtTok(costStats.median)} tok/item`,
			);
			if (costStats.groups.length)
				console.log(
					`    ${costStats.groups
						.slice(0, 5)
						.map(([g, tok]) => `${g} ${fmtTok(tok)}`)
						.join(" · ")}`,
				);
		}
	}
	// W633 brief weight: the per-dispatch instruction injection (brief
	// boilerplate + AGENTS.md chain + machine harness) and the REAL per-lane
	// in_tok from the buckle ledger — the weight audit, reportable per run.
	const bw = await briefWeight(days);
	if (bw) console.log(bw.line);
	if (bw?.laneTok?.length)
		console.log(
			`  buckle in_tok/req 30d: ${bw.laneTok
				.slice(0, 3)
				.map(
					(l) =>
						`${l.lane.replace(/-p98b.*$/, "")} ${fmtTok(Math.round(l.inTok / Math.max(1, l.reqs)))}`,
				)
				.join(" · ")} (${bw.laneTok.length} lanes)`,
		);
	// dwell: PAUSED windows are evented (paused → resume_ready); WAIT_RATE /
	// WAIT_DED leave no event trail, so ongoing dwell = now − lane.<sid>.state
	// fact ts (the only state history facts keep is their own last ts).
	const dwell: Record<string, { ms: number; n: number; ongoing: number }> = {};
	const pausedBy: Record<string, number> = {};
	for (const e of db
		.query(
			"SELECT ts, source, kind, target FROM events WHERE kind IN ('pause_requested','paused','resume_ready') AND ts >= ? ORDER BY ts, id",
		)
		.all(cut) as {
		ts: number;
		source: string;
		kind: string;
		target: string | null;
	}[]) {
		if (e.kind === "paused") pausedBy[e.source] = e.ts;
		else if (
			e.kind === "resume_ready" &&
			e.target &&
			pausedBy[e.target] != null
		) {
			if (!dwell.PAUSED) dwell.PAUSED = { ms: 0, n: 0, ongoing: 0 };
			const b = dwell.PAUSED;
			b.ms += Math.max(0, e.ts - pausedBy[e.target]);
			b.n++;
			delete pausedBy[e.target];
		}
	}
	for (const f of db
		.query(
			"SELECT value, ts FROM facts WHERE key LIKE 'lane.%.state' AND value IN ('WAIT_RATE','WAIT_DED','PAUSED')",
		)
		.all() as { value: string; ts: number }[]) {
		if (!dwell[f.value]) dwell[f.value] = { ms: 0, n: 0, ongoing: 0 };
		const b = dwell[f.value];
		b.ongoing += Math.max(0, now - f.ts);
	}
	const dwellLine = Object.entries(dwell)
		.filter(([, b]) => b.ms || b.ongoing)
		.map(
			([k, b]) =>
				`${k}${b.ms ? ` ${fmt(b.ms)}${b.n ? ` (${b.n} win)` : ""}` : ""}${b.ongoing ? ` +${fmt(b.ongoing)} ongoing` : ""}`,
		)
		.join(" · ");
	if (dwellLine) console.log(`  dwell: ${dwellLine}`);
	// friction: conflicts, rework (items claimed >1× — repairs/reclaims), fails
	const conflicts = (
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'conflict' AND ts >= ? AND project = ?",
			)
			.get(cut, project) as { n: number }
	).n;
	const failedQ =
		"SELECT COUNT(*) AS n FROM events WHERE kind = 'work.failed' AND ts >= ? AND project = ?";
	const failed = (db.query(failedQ).get(cut, project) as { n: number }).n;
	const rework = timing.filter((t) => t.claims > 1).length;
	console.log(
		`  friction: ${conflicts} conflict event${conflicts === 1 ? "" : "s"}, ${rework} re-claimed item${rework === 1 ? "" : "s"}, ${failed} failed`,
	);
	// self-serve: consults the plane resolved without spending a human's context
	const selfServe = db
		.query(
			"SELECT state, COUNT(*) AS n FROM consults WHERE project = ? AND answered_at >= ? AND state IN ('KB','LESSON') GROUP BY state",
		)
		.all(project, cut) as {
		state: string;
		n: number;
	}[];
	const kbN = selfServe.find((s) => s.state === "KB")?.n ?? 0;
	const lessonN = selfServe.find((s) => s.state === "LESSON")?.n ?? 0;
	console.log(
		`  self-serve: ${kbN} kb + ${lessonN} lesson answer${lessonN === 1 ? "" : "s"} (no expert round-trip)`,
	);
	// snapshot fact for trend diffing across waves
	const snap = {
		ts: now,
		days,
		project,
		runs: runs.reduce((a, r) => a + r.n, 0),
		byRole: Object.fromEntries(runs.map((r) => [r.role, r.n])),
		done: doneItems.length,
		open: openN,
		medianWallMs: med(doneItems.map((t) => t.wallMs)),
		medianAgentMs: med(doneItems.map((t) => t.agentMs)),
		dwell,
		conflicts,
		rework,
		failed,
		costItems: costStats?.costed,
		medianItemSpendTok: costStats?.median,
		costByGroup: costStats ? Object.fromEntries(costStats.groups) : undefined,
		brief_weight: bw && {
			brief: bw.w.brief,
			brief_chars: bw.w.briefChars,
			root_agents: bw.w.rootAgents,
			pkg_max: bw.w.pkgAgents[0] ?? null,
			harness: bw.w.harness,
			per_lane_static_tok: bw.w.perLaneStaticTok,
			buckle_lanes_30d: bw.laneTok.length,
		},
	};
	const snapKey = `metrics.snapshot.${new Date(now).toISOString().slice(0, 10)}`;
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'coord', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(snapKey, JSON.stringify(snap), now);
	console.log(`  ${dim(`snapshot → ${snapKey}`)}`);
}

/** W633: the brief+protocol weight line + per-lane real in_tok from the
 *  buckle ledger (BUCKLE_DB or the spoke default path). Null when the
 *  composer cannot load (non-fleet runs) — the section is omitted, never
 *  faked. */
async function briefWeight(
	days: number,
): Promise<{ w: BriefWeight; line: string; laneTok: LaneTokens[] } | null> {
	const fleetTree = resolve(import.meta.dir, "..", "..", "..", "..");
	const w = await measureBriefWeight(fleetTree);
	if (!w) return null;
	const pkg = w.pkgAgents[0];
	const parts = [
		`brief ${w.brief}`,
		w.rootAgents ? `agents-root ${w.rootAgents}` : null,
		pkg
			? `pkg-max ${pkg.tok} (${pkg.file.replace("packages/", "").replace("/AGENTS.md", "")})`
			: null,
		w.harness ? `harness ${w.harness}` : null,
	];
	const line = `  brief weight (W633, approx tok): ${parts.filter(Boolean).join(" · ")} ⇒ ${w.perLaneStaticTok}/lane`;
	const laneTok = buckleLaneTokens(buckleDbPath(), days);
	return { w, line, laneTok };
}

const buckleDbPath = (): string =>
	process.env.BUCKLE_DB || `${homedir()}/.claude/local-llm/buckle.db`;

export async function cmdDoctorSession(rest: string[]): Promise<void> {
	// rebind integrity: NO live coordination state may point at a closed
	// predecessor — everything here should be zero after resume-session
	const sid = rest[0];
	if (!sid) die("usage: doctor-session <sid>");
	const s = db
		.query("SELECT project, parent_sid FROM sessions WHERE sid = ?")
		.get(sid) as
		| { project: string | null; parent_sid: string | null }
		| undefined;
	if (!s) die(`no session: ${sid}`);
	const issues: string[] = [];
	const old = s.parent_sid;
	if (old) {
		const w = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED','FAILED')",
				)
				.get(s.project, old) as { n: number }
		).n;
		if (w) issues.push(`${w} work items still owned by ${old.slice(0, 8)}`);
		const c = (
			db.query("SELECT COUNT(*) AS n FROM claims WHERE sid = ?").get(old) as {
				n: number;
			}
		).n;
		if (c) issues.push(`${c} claims still on ${old.slice(0, 8)}`);
		const ncur =
			(
				db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
					event_id: number;
				} | null
			)?.event_id ?? 0;
		const e = (
			db
				.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?")
				.get(old, ncur) as { n: number }
		).n;
		if (e)
			issues.push(
				`${e} unconsumed events still addressed to ${old.slice(0, 8)}`,
			);
		const f = (
			db
				.query("SELECT COUNT(*) AS n FROM facts WHERE key LIKE ?")
				.get(`lane.${old}.%`) as { n: number }
		).n;
		if (f) issues.push(`${f} lane facts still keyed ${old.slice(0, 8)}`);
	}
	console.log(
		issues.length
			? `RESIDUE ${sid.slice(0, 8)}: ${issues.join("; ")}`
			: `✓ ${sid.slice(0, 8)} clean${old ? ` (lineage ${old.slice(0, 8)})` : ""}`,
	);
}

export async function cmdDiff(rest: string[]): Promise<void> {
	// W33 — the row-image read model: sessions/claims/locks/facts/work_items
	// mutate in place; the `deltas` trigger log is what makes "what actually
	// changed between two points" answerable. --since takes a deltas seq, an
	// events id (e<N> — or a bare number unknown to deltas), and resolves it
	// to the nearest strictly-later seq by ts. Terse per-table lines;
	// --json for machines.
	if (
		!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deltas'",
			)
			.get()
	)
		die(
			"no delta log in governor.db — open the DB once via the govdb module to install the v5 triggers",
		);
	const sinceArg = arg("--since");
	const tbl = arg("--table");
	const last = Math.max(1, Number(arg("--last") ?? 50));
	const wantJson = rest.includes("--json");
	const resolveSince = (s: string): { from: number; label: string } => {
		const byEvent = (id: number): { from: number; label: string } => {
			const ev = db.query("SELECT ts FROM events WHERE id = ?").get(id) as
				| { ts: number }
				| undefined;
			if (!ev) die(`--since: no event #${id}`);
			// strictly later: a delta written in the event's own ms is history
			const nxt = db
				.query("SELECT seq FROM deltas WHERE ts > ? ORDER BY ts, seq LIMIT 1")
				.get(ev.ts) as { seq: number } | undefined;
			return {
				from: nxt ? nxt.seq - 1 : Number.MAX_SAFE_INTEGER,
				label: `event #${id}`,
			};
		};
		const evM = /^e(?:v)?(\d+)$/i.exec(s);
		if (evM) return byEvent(Number(evM[1]));
		if (!/^\d+$/.test(s))
			die(`bad --since ${s} — want a deltas seq or an event id (42 or e42)`);
		const n = Number(s);
		if (db.query("SELECT 1 FROM deltas WHERE seq = ?").get(n))
			return { from: n, label: `seq ${n}` };
		return byEvent(n); // unknown to deltas → try the bus
	};
	const { from, label } =
		sinceArg == null ? { from: 0, label: "start" } : resolveSince(sinceArg);
	const where = tbl ? "seq > ? AND tbl = ?" : "seq > ?";
	const params: (number | string)[] = tbl ? [from, tbl] : [from];
	const tot = db
		.query(
			`SELECT COUNT(*) AS n, COUNT(DISTINCT tbl) AS t FROM deltas WHERE ${where}`,
		)
		.get(...params) as {
		n: number;
		t: number;
	};
	const rows = (
		db
			.query(
				`SELECT seq, ts, tbl, op, pk, before, after FROM deltas WHERE ${where} ORDER BY seq DESC LIMIT ?`,
			)
			.all(...params, last) as DeltaRow[]
	).reverse();
	// terse rendering: table  pk  op-glyph  changed-fields ("old→new"; a null
	// old prints as "field new"). Timeish fields (_at/ts/hb) render as HH:MM.
	const short = (s: string): string =>
		s.length > 24 ? `${s.slice(0, 23)}…` : s;
	const hhmm = (ms: number): string => {
		const d = new Date(ms);
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	};
	const val = (v: unknown): string => {
		const s = typeof v === "string" ? v : JSON.stringify(v);
		return !s ? "null" : s.length > 24 ? `${s.slice(0, 23)}…` : s;
	};
	const TIMEISH = /(_at$|^ts$|^hb$)/;
	const detail = (b: string | null, a: string | null): string => {
		if (!b || !a) return "";
		let bo: Record<string, unknown>;
		let ao: Record<string, unknown>;
		try {
			bo = JSON.parse(b);
			ao = JSON.parse(a);
		} catch {
			return "";
		}
		const changed = Object.keys(ao).filter(
			(k) => JSON.stringify(bo[k]) !== JSON.stringify(ao[k]),
		);
		return (
			changed
				.slice(0, 4)
				.map((k) => {
					const o = bo[k];
					const n = ao[k];
					if (TIMEISH.test(k) && typeof n === "number" && n > 1e12)
						return `${k} ${typeof o === "number" && o > 1e12 ? `${hhmm(o)}→` : ""}${hhmm(n)}`;
					return o == null ? `${k} ${val(n)}` : `${k} ${val(o)}→${val(n)}`;
				})
				.join(", ") + (changed.length > 4 ? ` +${changed.length - 4} more` : "")
		);
	};
	// pk display: sids truncate to the house 8-char style; work-item pks carry
	// an absolute project path — collapse to …<repo>/<id>
	const pkShow = (t: string, pk: string): string => {
		if (t === "sessions") return `${pk.slice(0, 8)}…`;
		if (t === "work_items" && pk.includes("/")) {
			const i = pk.lastIndexOf("/");
			return `…${pk
				.slice(0, i)
				.split("/")
				.pop()
				?.replace(/\.git$/, "")}/${pk.slice(i + 1)}`;
		}
		return short(pk);
	};
	const glyph = (op: string): string =>
		op === "insert" ? green("+") : op === "delete" ? red("-") : cyan("~");
	const img = (s: string | null): unknown => {
		try {
			return s == null ? null : JSON.parse(s);
		} catch {
			return s;
		}
	};
	if (wantJson) {
		console.log(
			JSON.stringify({
				since: label,
				total: tot.n,
				tables: tot.t,
				shown: rows.length,
				changes: rows.map((r) => ({
					seq: r.seq,
					ts: r.ts,
					tbl: r.tbl,
					op: r.op,
					pk: r.pk,
					before: img(r.before),
					after: img(r.after),
				})),
			}),
		);
	} else {
		for (const r of rows)
			console.log(
				`${r.tbl.padEnd(11)} ${dim(pkShow(r.tbl, r.pk))} ${glyph(r.op)} ${detail(r.before, r.after)}`.trimEnd(),
			);
		console.log(
			dim(
				`${tot.n} change${tot.n === 1 ? "" : "s"} across ${tot.t} table${tot.t === 1 ? "" : "s"}${sinceArg != null ? ` since ${label}` : ""}${rows.length < tot.n ? ` — last ${rows.length} shown` : ""}`,
			),
		);
	}
}

// ─── events (W430): the bus's own trail gets a read verb ────────────────────
// The events table had no CLI read surface — raw sqlite3 json_extract probes
// happened twice in one day (W430), a surface-law violation. `coord events`
// reads the trail through the same store lib every verb uses: --kinds csv
// exact-match, --last N newest-first (default 50), --json for machines.
// Rendering reuses formatEventLine — one row-renderer for the bus (wait and
// subscribe already share it) — plus an age column, since a replay reads
// older rows than a live poll.
const parsePayload = (s: string | null): unknown => {
	if (s == null) return null;
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
};
export async function cmdEvents(rest: string[]): Promise<void> {
	const kinds = arg("--kinds")?.split(",").filter(Boolean) ?? [];
	const last = Number(arg("--last") ?? 50);
	if (!Number.isInteger(last) || last < 1)
		die("--last must be a positive integer");
	const wantJson = rest.includes("--json");
	const where = kinds.length
		? `WHERE kind IN (${kinds.map(() => "?").join(", ")})`
		: "";
	const kindParams: string[] = kinds;
	const tot = (
		db
			.query(`SELECT COUNT(*) AS n FROM events ${where}`)
			.get(...kindParams) as { n: number }
	).n;
	const rows = db
		.query(
			`SELECT id, ts, source, kind, scope, payload FROM events ${where} ORDER BY id DESC LIMIT ?`,
		)
		.all(...kindParams, last) as Ev[];
	if (wantJson) {
		console.log(
			JSON.stringify({
				total: tot,
				kinds,
				shown: rows.length,
				events: rows.map((r) => ({
					id: r.id,
					ts: r.ts,
					source: r.source,
					kind: r.kind,
					scope: r.scope,
					payload: parsePayload(r.payload),
				})),
			}),
		);
		return;
	}
	for (const r of rows)
		console.log(`${dim(ageOf(r.ts).padStart(4))}${formatEventLine(r)}`);
	console.log(
		dim(
			`${tot} event${tot === 1 ? "" : "s"}${kinds.length ? ` of kind ${kinds.join(",")}` : ""}${rows.length < tot ? ` — last ${rows.length} shown` : ""}`,
		),
	);
}

// ─── project identity (W428): identity + rekey ───────────────────────────
// projectIdentity() = realpath of the git-common-dir — the monorepo cutover
// left the historical graph keyed to the OLD repo's git dir while new
// sessions open under klh/fleet. The migration is a VERB (surface law):
// one transactional rekey across every project-scoped table, refused when
// the target identity already carries a work graph.
// children FIRST — work_deps holds composite FKs to work_items(project,id);
// with foreign_keys=ON a parent-first UPDATE violates them (the W428 rekey
// hit 500s on exactly these two tables). defer_foreign_keys inside the tx
// relaxes the rest.
const PROJECT_TABLES = [
	"work_deps",
	"work_items",
	"work_sequences",
	"work_spend_histogram",
	"consults",
	"consult_kb",
	"sessions",
] as const;

export async function cmdProject(rest: string[]): Promise<void> {
	const sub = rest[0];
	if (sub === "identity") {
		console.log(projectIdentity());
		return;
	}
	if (sub === "enroll") return cmdEnroll(rest);
	if (sub === "bind") return cmdBind(rest);
	if (sub === "verify") return cmdVerify(rest);
	if (sub !== "rekey")
		die(
			"usage: coord project identity | coord project rekey <old> <new> | coord project enroll|bind|verify",
		);
	const pos = rest.slice(1).filter((a) => !a.startsWith("--"));
	const [from, to] = pos;
	if (!from || !to) die("usage: coord project rekey <old> <new>");
	if (from === to) die("rekey: old and new identity are identical");
	// exclusivity rail: rows landing on an occupied target is a graph MERGE
	const targetItems = (
		db
			.query("SELECT COUNT(*) AS n FROM work_items WHERE project = ?")
			.get(to) as { n: number }
	).n;
	if (targetItems > 0)
		die(
			`rekey refused: target already holds ${targetItems} work item(s) — resolve the target graph first`,
		);
	const countIn = (tbl: string): number =>
		(
			db
				.query(`SELECT COUNT(*) AS n FROM ${tbl} WHERE project = ?`)
				.get(from) as { n: number }
		).n;
	const counts = Object.fromEntries(
		PROJECT_TABLES.map((t) => [t, countIn(t)]),
	) as Record<string, number>;
	// decisions is board-owned (created on board boot), not in the govdb
	// migrations — a coord-only store may lack the table; migrate it when
	// present so a rekeyed graph doesn't strand NEED_DECISION rows on the
	// old project key (W460, docs/cross-hub-project-identity.md hazard)
	const hasDecisions = !!db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decisions'",
		)
		.get();
	if (hasDecisions) counts.decisions = countIn("decisions");
	const hasRecovery = !!db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_recovery_attempts'",
		)
		.get();
	if (hasRecovery) {
		counts.work_recovery_attempts = countIn("work_recovery_attempts");
		if (
			(
				db
					.query(
						"SELECT COUNT(*) AS n FROM work_recovery_attempts WHERE project=?",
					)
					.get(to) as { n: number }
			).n
		)
			die("rekey refused: target already holds recovery budget records");
	}
	const launchTables = [
		"lane_launch_intents",
		"lane_launch_budgets",
		"lane_launch_leases",
	].filter(
		(table) =>
			!!db
				.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
				.get(table),
	);
	for (const table of launchTables) counts[table] = countIn(table);
	const hasCompletions = !!db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_completion_records'",
		)
		.get();
	if (hasCompletions) {
		counts.work_completion_records = countIn("work_completion_records");
		const targetRecords = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM work_completion_records WHERE project = ?",
				)
				.get(to) as { n: number }
		).n;
		if (targetRecords)
			die(
				`rekey refused: target already holds ${targetRecords} completion record(s)`,
			);
	}

	const eventsN = (
		db
			.query("SELECT COUNT(*) AS n FROM events WHERE project = ?")
			.get(from) as { n: number }
	).n;
	// W687: item capsules ride facts keys tagged with sha256(projectIdentity) —
	// a rekey must carry them or the hand-offs strand on the old hash. The
	// exclusivity rail above already refuses an occupied target graph.
	const capsulePrefix = `work.capsule.${capsuleProjectTag(from)}.`;
	const capsuleN = (
		db
			.query("SELECT COUNT(*) AS n FROM facts WHERE key LIKE ?")
			.get(`${capsulePrefix}%`) as { n: number }
	).n;
	counts["capsule facts"] = capsuleN;
	db.transaction(() => {
		// composite FKs (work_deps→work_items) defer to COMMIT
		db.run("PRAGMA defer_foreign_keys = ON");
		for (const table of launchTables) {
			const target = db
				.query(`SELECT COUNT(*) AS n FROM ${table} WHERE project=?`)
				.get(to) as { n: number };
			if (target.n)
				throw new Error(
					`rekey refused: target already holds launch records in ${table}`,
				);
			db.run(`UPDATE ${table} SET project=? WHERE project=?`, to, from);
		}
		if (
			hasRecovery &&
			(
				db
					.query(
						"SELECT COUNT(*) AS n FROM work_recovery_attempts WHERE project=?",
					)
					.get(to) as { n: number }
			).n
		)
			throw new Error(
				"rekey refused: target already holds recovery budget records",
			);
		if (hasCompletions) {
			ensureCompletionIdentityMigration(db);
			db.run(
				"UPDATE work_completion_records SET project = ? WHERE project = ?",
				to,
				from,
			);
		}

		for (const t of PROJECT_TABLES)
			db.run(`UPDATE ${t} SET project = ? WHERE project = ?`, to, from);
		if (capsuleN)
			db.run(
				// key = prefix-for-to || item tail; substr is 1-based, the prefix
				// (with its trailing dot) is exactly what the item index skips
				"UPDATE facts SET key = ? || substr(key, ?) WHERE key LIKE ?",
				`work.capsule.${capsuleProjectTag(to)}.`,
				capsulePrefix.length + 1,
				`${capsulePrefix}%`,
			);
		if (hasDecisions)
			db.run("UPDATE decisions SET project = ? WHERE project = ?", to, from);
		if (hasRecovery)
			db.run(
				"UPDATE work_recovery_attempts SET project=? WHERE project=?",
				to,
				from,
			);
		db.run(
			// column + payload ride together — the trigger stamps INSERTs only, so
			// the rekey's in-place payload mutation must move the column itself
			"UPDATE events SET payload = json_set(payload, '$.project', ?), project = ? WHERE project = ?",
			to,
			to,
			from,
		);
	})();
	console.log(green(`project rekey: ${from} → ${to}`));
	for (const [t, n] of Object.entries(counts))
		if (n > 0) console.log(`  ${t.padEnd(15)} ${n}`);
	console.log(`  ${"events($.project)".padEnd(15)} ${eventsN}`);
	return;
}
