// scripts/lib/brief.ts — the dispatch brief composer (W633 decomposition of
// dispatch-next.ts, pulled out under the 1500-line law). One source of truth
// for the per-lane instruction injection.
//
// W633 trim doctrine: the brief carries only lane-specific facts and the
// commands the lane must run; doctrine AGENTS.md already carries lives there
// (the PROTOCOL line points at it) — redundancy here is measured by
// scripts/lib/brief-weight.ts and surfaced in `coord metrics`.
import { condensePrompt } from "../../hooks/board/prompt-transform.ts";
import { effortBudgetLine } from "../../hooks/lib/work-effort.ts";
import { capsuleValidity } from "../../hooks/lib/capsule-fence.ts";
import { validationCommand } from "./validation-cmd.ts";
// W254: pointer-grade injection — file-map + done-definition digest for the
// brief, gated per W113 on repo size (hooks/lib/brief-intel.ts)
import { renderIntel, type BriefIntel } from "../../hooks/lib/brief-intel.ts";

/** hooks bin dir (env-overridable — the shims ride the same path). */
export const BIN = `${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin`;

/** ANSI SGR sequence stripper (same shape as dispatch-next's). */
export const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// W494 law: the brief's repo fallback is the repo ROOT, never cwd —
// dispatch-next passes repo explicitly on spawn paths; the dry/preview path
// omits it, and the fallback keeps those briefs honest too.
const gitToplevel = (): string => {
	const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = p.stdout ? new TextDecoder().decode(p.stdout).trim() : "";
	return out || process.cwd();
};
const REPO = gitToplevel();

export interface BriefOpts {
	item: string;
	showOut: string;
	sid: string;
	branch: string;
	worktree: string;
	capsule: Record<string, string> | null;
	/** W617: item-scoped capsule — rides for ANY claimer */
	itemCapsule?: Record<string, string> | null;
	repo?: string;
	aids?: string[];
	extra?: string[];
	agent?: string;
	/** archived-origin landing redirect (the W428 lesson) */
	landing?: string;
	/** W248: per-item effort budget — vocabulary + budget text live in
	 *  hooks/lib/work-effort.ts; absent/null = no budget line. */
	effort?: string | null;
	/** W645: explicit validation command (tests); undefined = detect from
	 *  qlty/package metadata, null = drop the line entirely. */
	validation?: string | null;
	/** W254: pointer-grade brief intel — file-map + done-definition digest,
	 *  derived at dispatch from the mission text; absent/null = no sections. */
	intel?: BriefIntel | null;
}

const briefOpening = (o: BriefOpts): string[] => {
	// W248: the per-item effort budget rides the brief — simple = work solo,
	// 3-10 tool calls; complex = fan out via work split; unset = no budget
	// line (legacy briefs stay byte-identical).
	const budget = effortBudgetLine(o.effort);
	return [
		`You are lane "${o.sid}", Work Graph item ${o.item}, repo ${o.repo ?? REPO}. English only.`,
		``,
		`IDENTITY: executor ${o.agent ?? "claude"}. [HUB] prefixes are labels — traffic routes through that hub's gateway.`,
		``,
		`MISSION (from work show):`,
		// W334 caveman tier at the source: the lane's actual prompt text gets
		// the condense pass (filler/meta/dedupe, technical surface masked).
		condensePrompt(o.showOut.replace(ANSI, "").trim()),
		...(budget ? [budget] : []),
		// W254: pointer-grade injection — file-map + done-definition digest
		// right after the mission; gates log their skips (never silent).
		...(renderIntel(o.intel).length ? ["", ...renderIntel(o.intel)] : []),
		``,
		`PROTOCOL: BEFORE any edit, read AGENTS.md in the repo root and follow it (plan-first, shatter judgment, gates, done protocol, final-line vocabulary).`,
		`FORMAT: read the nearest .qlty/qlty.toml + Biome config before writing; qlty fmt + check on changed files before final checks, tests and commit — full doctrine: AGENTS.md. Never chase formatter wrapping by hand.`,
	];
};

// W645 (oh-my-claude L5): the concrete validation command for the target
// repo, read from qlty + package metadata — never guessed, never hardcoded
// per-ecosystem. A repo with no metadata source gets no line at all.
const briefValidation = (o: BriefOpts): string[] => {
	const cmd =
		o.validation !== undefined
			? o.validation
			: validationCommand(o.repo ?? REPO);
	if (!cmd) return [];
	return [``, `VALIDATION (<files> = the paths you changed): ${cmd}`];
};

// W633 trim: inbox + collaboration + verdicts carry the commands; the long
// rationale prose went to AGENTS.md (protocol 1 + consult narration), where
// the PROTOCOL line already points. Vocab anchors tests regex stay verbatim.
const briefInboxCollab = (o: BriefOpts): string[] => [
	`INBOX CONTRACT (WS-first): one live coord subscribe attaches at spawn (idempotent per sid); its feed tails ~/.claude-insights/coord-subscribe-${o.sid}.log (read with tail). Catch-up read on every executor: bun ${BIN}/coord.ts inbox --as ${o.sid} — check before planning and again before finishing.`,
	`COLLABORATION: after a second unchanged failure or an interface conflict, consult ONE expert: bun ${BIN}/coord.ts consult --best "<command, error, attempts, precise question>" --scope "<package/path>" --as ${o.sid}; no answer in 60s → capsule the evidence, keep moving, request a decision before another unchanged attempt. Replies: answer, evidence, applicability, next action; after trying one: bun ${BIN}/coord.ts consult-reply <Cnumber> --feedback resolved|failed|unused --evidence "<command and observed result>" --as ${o.sid}.`,
	`REPORT VERDICTS: report-shaped output — review, QA pass, consult answer, paired-lane findings — ends with ONE machine-parseable final line, never paraphrased: review = VERDICT: PASS | VERDICT: FAIL - <reason> · critique = APPROVED | NEEDS REVISION - <reason> · gap analysis = CLEAR | GAPS_FOUND - <detail> | INSUFFICIENT_CONTEXT. Parents regex the final line, not the prose.`,
	`VERDICT CONTRACT: if the item IS a review/verify/critique, that final line is MANDATORY — the parent regexes it, prose is ignored. Consuming a verdict (writer lane): regex the FINAL line only — PASS/APPROVED/CLEAR proceeds; FAIL/NEEDS REVISION/GAPS_FOUND fails fast (fix or coord consult), never reinterpreted as a pass.`,
	`Work in the EXISTING worktree ${o.worktree} (branch ${o.branch}).`,
];

const briefResume = (o: BriefOpts): string[] => [
	``,
	`CAPSULE PROTOCOL — resumable lanes: at every work-unit boundary (a gate passed, a commit landed, before any pause) bank a ≤10-line capsule:`,
	`  bun ${BIN}/coord.ts capsule set --as ${o.sid} --checkpoint=<branch-head-sha|none> --file="<anchor path:line>" --done="<done so far>" --next="<next step>"`,
	`The LAST capsule stands as the hand-off: if this lane dies, the next dispatch resumes from it. A stale or missing capsule strands the work.`,
	``,
	`RESUME PATH: while your process is alive you are reachable via your sid — it is the item's owner_sid on the graph, and coord inbox --as ${o.sid} reaches you. If you die mid-item, the fleet loop re-dispatches the SAME sid, reads your latest capsule, and returns it below as RESUME CONTEXT. Reconcile with it and the worktree state — never restart blind.`,
];

// W643: the reconciliation check is COMPUTED, not prose — real git evidence
// for the resumed lane: where the worktree head stands vs the capsule's
// checkpoint (fresh / behind / diverged verdict + staleness lines).
const gitIn = (dir: string, args: string[]): string =>
	new TextDecoder()
		.decode(
			Bun.spawnSync(["git", "-C", dir, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			}).stdout ?? new Uint8Array(),
		)
		.trim();

export const resumeCheckLines = (o: {
	capsule?: Record<string, string> | null;
	itemCapsule?: Record<string, string> | null;
	worktree: string;
}): string[] => {
	const capsule = o.capsule ?? o.itemCapsule;
	if (!capsule) return [];
	const v = capsuleValidity(capsule as Record<string, unknown>, {
		repoDir: o.worktree,
		headSha: gitIn(o.worktree, ["rev-parse", "HEAD"]) || null,
		dirty: gitIn(o.worktree, ["status", "--porcelain"])
			.split("\n")
			.filter(Boolean).length,
	});
	return v.lines.length ? [``, ...v.lines] : [];
};

const briefLanding = (o: BriefOpts): string[] => [
	``,
	`LANDING CHAIN (all three, in order):`,
	`1. commit on ${o.branch} (subject starts with the item id) — land a checkpoint commit early (zero-commit branches get reaped).`,
	...(o.landing ? [o.landing] : []),
	`2. bun ${BIN}/work.ts done ${o.item} --sha <branch-head> --as ${o.sid}`,
	`   (claim-token gated, W643: your token rides KLH_CLAIM_TOKEN + .fleet/lane-context.json — only manual closes need --token, printed once at take)`,
	`3. bun ${BIN}/coord.ts fact set finding.${o.item.toLowerCase()} --text "<one-line headline + how to verify>" --source ${o.sid}`,
	``,
	`IDENTITY: prefix progress notes, inbox replies and final reports with [${o.item}] (+ locality tag when it aids scanning — [${o.item}·local|remote|sim|buckle]); humans deep-link your item on the fleet board as #task=${o.item}${process.env.FLEET_BOARD_URL ? ` (full URL: ${process.env.FLEET_BOARD_URL}/#task=${o.item})` : ""}; include the link in your final report.`,
	`CRAFT: ≤25-line anchored edits per write (content gate parse-checks; splice via /tmp chunks for larger); build verify every ~3rd edit; GUI deliverables get a headless-Chrome render-and-look pass against the LIVE surface with real data — report what you saw; evidence before claims, always.`,
	`ORACLE: need a review or hard analysis? bun ${BIN}/oracle.ts review | bugs | analyze (--in FILE, else the working-tree diff; --cloud = the stronger route) — the named stateless escalation on the pinned strong route; never ad-hoc "please review" phrasing.`,
	`VOICE (owner law 2026-10-03): terse — no preamble, no restating the task, no filler; minimal prose in commits, progress notes, questions and .klh-done.md. Tokens spent on prose are tokens not spent on work.`,
	``,
	`Final: DONE <sha> | SPLIT ${o.item} | BLOCKED (after 3 honest attempts, tree restored).`,
];

export const composeBrief = (o: BriefOpts): string => {
	const parts = briefOpening(o);
	parts.push(...briefValidation(o));
	parts.push(...briefInboxCollab(o));
	parts.push(...briefResume(o));
	parts.push(...resumeCheckLines(o));
	parts.push(...briefLanding(o));
	// W146 interfaces: aids = knowledge-interface lines for the child lane;
	// extra = supervisor context lines appended verbatim.
	if (o.aids?.length)
		parts.push(
			``,
			`AIDS (knowledge interfaces):`,
			...o.aids.map((a) => `  - ${a}`),
		);
	if (o.extra?.length) parts.push(``, ...o.extra);
	if (o.capsule)
		parts.push(
			``,
			`RESUME CONTEXT — latest capsule from a previous run of this lane (reconcile with the worktree + item state before continuing):`,
			JSON.stringify(o.capsule),
		);
	if (
		o.itemCapsule &&
		JSON.stringify(o.itemCapsule) !== JSON.stringify(o.capsule)
	)
		parts.push(
			``,
			`RESUME CONTEXT — item capsule from a previous lane on this item (any claimer; reconcile with the worktree + item state before continuing):`,
			JSON.stringify(o.itemCapsule),
		);
	return parts.join("\n");
};
