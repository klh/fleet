// hooks/gates/ask.ts — W817 ask-in-session wiring. When the owner asks a
// meta/fleet question in ANY session (UserPromptSubmit), the coordinator
// session should receive + answer it. Cheap screens (length, question shape,
// fleet vocabulary) gate a kev-class triage (self vs coordinator) with the
// lesson/fact lookup riding FIRST — the consult CLI re-runs the same lookups
// on its side, so a verified fact/kb answer never pings a human. Routing is
// `coord consult <coordinator-sid> "<q>" --as <sid>`: OPEN consult, WS-pushed
// to the coordinator's inbox, deadline-tracked like every consult. Advisory
// law: every failure mode stays silent (allow) — a prompt is never blocked.
// SUSPENDERS_ASK=0 disables the surface.
import { allow, context, type HookInput } from "../lib/hookio.ts";
import { kevTypedDecision } from "../lib/knowledge/kev.ts";
import { resolveFleetLane } from "../lib/lanes/fleetlane.ts";
import { subagentLaneSuffix } from "../lib/lanes/subscribe-attach.ts";
import { drainLaneInboxFor } from "../lib/lanes/lane-inbox.ts";

// owner meta questions are short; dispatch briefs (thousands of chars, ride
// the session's FIRST prompt with W-ids all over them) never survive this
export const ASK_MAX_PROMPT = 800;
// kev-cold can take tens of seconds — untenable mid-prompt; a cap that
// misses falls to the deterministic fallback below
const ASK_KEV_TIMEOUT_MS = 5_000;
const ASK_CONSULT_TIMEOUT_MS = 10_000;
const ASK_QUESTION_MAX = 500;

// question shape: "?" anywhere or a leading interrogative (en + da)
const QUESTION_WORDS =
	"how|why|what|whats|where|when|who|whom|whose|which|should|is|are|does|do|can|could|did|has|have|was|were|er|hvad|hvem|hvorfor|hvordan|hvor";

export function isQuestionShaped(prompt: string): boolean {
	const t = prompt.trimStart();
	if (t.includes("?")) return true;
	return new RegExp(`^(?:${QUESTION_WORDS})\\b`, "i").test(t);
}

// fleet-meta vocabulary: one hit is a signal, the pair (id or 2+) is strong
// — plain nouns of the plane, no project names hardcoded (config-over-code)
const FLEET_TOKENS: [RegExp, string][] = [
	[/\bW\d+\b/, "work-item id"],
	[/\blanes?\b/i, "lane"],
	[/\bwork\s?(items?|graph|tree)\b/i, "work graph"],
	[/\bcoordinator\b/i, "coordinator"],
	[/\bconsult(s|ed|ing)?\b/i, "consult"],
	[/\bdispatch(ers?|ed|es)?\b/i, "dispatch"],
	[/\bworktrees?\b/i, "worktree"],
	[/\bgovern(or|.db)?\b/i, "governor"],
	[/\bfleet\b/i, "fleet"],
	[/\bREADY|CLAIMED\b/, "work state"],
	[/\bboard\b/i, "board"],
	[/\bsupersede(d|s)?\b/i, "supersede"],
	[/\brekey\b/i, "rekey"],
	[/\bkev\b/i, "kev"],
];

export function fleetMetaHits(prompt: string): string[] {
	const hits: string[] = [];
	for (const [re, label] of FLEET_TOKENS)
		if (re.test(prompt) && !hits.includes(label)) hits.push(label);
	return hits;
}

// deterministic fallback when kev can't answer in time: W-id or two distinct
// signals route; a single weak signal stays silent (owner intent — meta
// questions REACH the coordinator — only wins on strong evidence)
export function fallbackVerdict(hits: string[]): "self" | "coord" | null {
	if (hits.includes("work-item id") || hits.length >= 2) return "coord";
	return null;
}

// the live coordinator: coordinator.sid fact first (the sweep exempts it, so
// a sleeping coordinator stays RUNNING), then a RUNNING role=coordinator row
type Store = {
	query: (sql: string) => {
		get: (...p: unknown[]) => unknown;
		all: (...p: unknown[]) => unknown[];
	};
};
export function liveCoordinator(db: Store, project: string): string | null {
	const fact = (
		db.query("SELECT value FROM facts WHERE key = 'coordinator.sid'").get() as
			| { value: string }
			| undefined
	)?.value;
	if (fact) {
		const ok = db
			.query(
				"SELECT 1 FROM sessions WHERE sid = ? AND project = ? AND state = 'RUNNING'",
			)
			.get(fact, project);
		if (ok) return fact;
	}
	const row = db
		.query(
			"SELECT sid FROM sessions WHERE role = 'coordinator' AND state = 'RUNNING' AND project = ? ORDER BY hb DESC LIMIT 1",
		)
		.get(project) as { sid: string } | undefined;
	return row?.sid ?? null;
}

// lane id — the push-gate resolution order (env sid → ppid-walk → session_id
// + subagent suffix); a subagent lane never routes owner questions
function laneIdFor(hook: HookInput): string | null {
	if (subagentLaneSuffix(hook.transcript_path ?? "")) return null;
	const env = process.env.SUSPENDERS_SID;
	if (env) return env;
	const lane = resolveFleetLane(hook.cwd ?? process.cwd());
	if (lane) return lane.sid;
	return hook.session_id ?? null;
}

// Promise<never> by construction: the async body exits the process on every
// path (allow/context are `: never`) — gate.ts's case parks on the await
export function askGate(hook: HookInput): Promise<never> {
	if (process.env.SUSPENDERS_ASK === "0") allow();
	return (async () => {
		const prompt = hook.prompt?.trim() ?? "";
		// W861 delivery leg: consult answers/expiry notices targeted at THIS
		// session drain into the transcript on the next prompt — the asking
		// session sees the coordinator's answer without a tool call (the W611
		// files-gate seam covers dispatched lanes; the ask gate's own sid
		// resolution reaches any asking session, the owner's interactive one
		// included).
		const sid = laneIdFor(hook);
		const delivered = sid ? drainLaneInboxFor(sid) : null;
		// context() exits the process, so the drain block composes with any
		// ask note the screens produce — one exit, no dropped leg
		const done = (askNote?: string): never => {
			if (delivered && askNote)
				context(`${delivered}\n${askNote}`, "UserPromptSubmit");
			if (askNote) context(askNote, "UserPromptSubmit");
			if (delivered) context(delivered, "UserPromptSubmit");
			allow();
		};
		if (!prompt || prompt.length > ASK_MAX_PROMPT) done();
		if (!isQuestionShaped(prompt)) done();
		const hits = fleetMetaHits(prompt);
		if (hits.length === 0) done();
		if (!sid) done();

		try {
			const shared = await import("../coord/shared.ts");
			const project = shared.projectIdentity(hook.cwd ?? process.cwd());
			const coordSid = liveCoordinator(shared.db, project);
			// no live coordinator (other repos, hub machines) → silent; the
			// coordinator's own session never routes to itself
			if (!coordSid || coordSid === sid) {
				done();
				return;
			}
			const q = prompt.replace(/\s+/g, " ").slice(0, ASK_QUESTION_MAX);

			// lesson/fact lookup FIRST — a verified knowledge row answers by the
			// plane (the self path) exactly as the consult CLI would
			const factHit = await shared.factLookup(q);
			if (factHit) {
				done(
					`[fleet-ask] self-answerable — verified fact k#${factHit.id} "${factHit.topic ?? ""}": ${(factHit.fact ?? "").slice(0, 300)}`,
				);
				return;
			}
			const lessonHit = shared.lessonLookup(q);

			// kev triage: coordinator or self-answerable
			let verdict = fallbackVerdict(hits);
			let source = "fallback";
			const d = await kevTypedDecision({
				state: [
					`question: ${q}`,
					`fleet signals: ${hits.join(", ")}`,
					lessonHit
						? `nearest lesson ${lessonHit.key} (score ${lessonHit.score}, advisory): ${lessonHit.value.slice(0, 200)}`
						: "no lesson match",
				].join("\n"),
				question:
					"A fleet-meta question arrived mid-session. Does answering it need the coordinator's fleet-wide view, or is it self-answerable from fleet knowledge?",
				options: [
					{
						label: "coord",
						tradeoff: "fleet-wide state/decision only the coordinator holds",
					},
					{
						label: "self",
						tradeoff:
							"lessons/facts already answer it; the session self-serves",
					},
				],
				timeoutMs: ASK_KEV_TIMEOUT_MS,
			});
			if (d) {
				verdict = d.choice as "self" | "coord";
				source = `kev ${Math.round(d.confidence * 100)}%`;
			}
			if (verdict !== "coord") {
				done(
					lessonHit
						? `[fleet-ask] kev triage: self-answerable — nearest lesson ${lessonHit.key} (advisory): ${lessonHit.value.slice(0, 250)}`
						: `[fleet-ask] triage: self-answerable — coord fact list / who-knows cover this without the coordinator`,
				);
				return;
			}

			// dedup: an OPEN consult for the same asker+question is already in
			// flight — re-inject the pointer, never a second row
			const dup = shared.db
				.query(
					"SELECT id FROM consults WHERE asker_sid = ? AND question = ? AND state = 'OPEN'",
				)
				.get(sid, q) as { id: number } | undefined;
			if (dup) {
				done(
					`[fleet-ask] already routed as C${dup.id} — the coordinator's answer arrives via the WS inbox and is delivered into this session on the next prompt`,
				);
				return;
			}

			// route: the real consult CLI (validation, deadline, WS push, board)
			const coordCli = joinCli("coord.ts");
			const r = Bun.spawnSync(
				[process.execPath, coordCli, "consult", coordSid, q, "--as", sid],
				{
					cwd: hook.cwd ?? process.cwd(),
					stdout: "pipe",
					stderr: "pipe",
					timeout: ASK_CONSULT_TIMEOUT_MS,
				},
			);
			const out = `${r.stdout}${r.stderr}`;
			const m = out.match(/CONSULT (C\d+)/);
			if (r.exitCode !== 0 || !m) {
				// advisory: silent fail-open; the debug knob makes wiring bugs visible
				if (process.env.SUSPENDERS_ASK_DEBUG)
					process.stderr.write(
						`[fleet-ask] consult spawn failed: ${`${r.stdout}${r.stderr}`.slice(0, 400)}\n`,
					);
				done();
			}
			done(
				`[fleet-ask] routed to the coordinator as ${m[1]} (${source}) — the answer is delivered into this session on the next prompt (coord consults --as ${sid.slice(0, 8)} lists it too)`,
			);
		} catch (e) {
			// advisory law — never block the prompt; SUSPENDERS_ASK_DEBUG=1
			// surfaces the swallowed failure for diagnosis (wiring bugs stay visible)
			if (process.env.SUSPENDERS_ASK_DEBUG)
				process.stderr.write(`[fleet-ask] ${e}\n`);
			done();
		}
	})();
}

// bin/ sibling of this gate (installed prefix and repo checkout share the
// layout) — mirrors coordCliPath without the deprecated legacy fallback
function joinCli(name: string): string {
	return `${import.meta.dir}/../bin/${name}`;
}
