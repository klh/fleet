// bench/w949 — the blind knowledge-retrieval A/B: LLM-banked layer
// (coord facts + consult_kb) vs the mechanical layer (decant FTS +
// stats over the same transcripts). Owner 2026-10-19: is banking
// knowledge cheaper AND better than pure mechanical retrieval?
// Identity-blind per consult-v2: the judge scores anonymized answers
// against arm-neutral ground-truth memos, never the arm label.
export type QuestionClass = "telemetry" | "judgment";

export interface Question {
	id: string;
	class: QuestionClass;
	// The ask, phrased as a lane would ask it.
	q: string;
	// Arm-neutral ground truth (frozen 2026-10-19 from primary records:
	// W776 attribution rows, git show, the gate/relay source). The judge
	// sees this; the arms never did.
	gt: string;
	// Primary-record provenance for the memo.
	src: string;
}

export const QUESTIONS: Question[] = [
	{
		id: "T1",
		class: "telemetry",
		q: "How much token spend (fresh, cached, output) did item W932 burn, and in how many requests?",
		gt: "W776 ledger view: ~30.8M tokens (fresh+cached), 99% cache hit, 1701 out/min, 1h09m agent. Independent decant view (generation tokens, cache-excl.): 272,467 in / 111,465 out ≈ $1.01. Either labeled view is a correct answer; the ~100× spread IS the metric-family gap W943 audits.",
		src: "work report --ids W932 + decant ls --project (frozen 2026-10-19)",
	},
	{
		id: "T2",
		class: "telemetry",
		q: "Which files did the W935 lane touch, and in which commit did its work land?",
		gt: "5 files @ merge c8003791 (Merge suspenders/W935): packages/buckle/src/adapters/anthropic.ts, openai-compat.ts, types.ts, test/adapters-wire.test.ts, upstreams.copilot.yaml (+98/−139).",
		src: "git show c8003791 --stat (frozen 2026-10-19)",
	},
	{
		id: "T3",
		class: "telemetry",
		q: "How much wall/agent time did W918 take and what was its cache hit rate?",
		gt: "W776 view: 1h52m agent, 99% cache hit, 11.7M tokens, 491 out/min. decant view: one 28-min session, 446 msgs, 140k in / 55k out. Both labeled views correct; the spread (multiple dispatch attempts per item vs per-transcript span) is the known W943 domain.",
		src: "work report --ids W918 + decant ls --project (frozen 2026-10-19)",
	},
	{
		id: "T4",
		class: "telemetry",
		q: "Which model and effort level ran the W918.5 lane, and what output rate did it sustain?",
		gt: "glm-5.3-flash, effort medium (dispatch-pinned), 2174 out/min over 19m. decant view: same model, 20-min session, 41,417 out ≈ 2,070/min. Model and rate agree across views; effort differs by inference method.",
		src: "work report --ids W918.5 + decant ls --project (frozen 2026-10-19)",
	},
	{
		id: "T5",
		class: "telemetry",
		q: "Among DONE items, which burned the most agent minutes recently and roughly how much?",
		gt: "W927: W776 view 1h27m agent / 35.3M tokens (99% cache); decant view 89-min session, 172k out, ~$1.19 — largest of the DONE set on both views.",
		src: "work report last-5-done rows + decant ls --project (frozen 2026-10-19)",
	},
	{
		id: "J1",
		class: "judgment",
		q: "Why does the scrub pre-push gate re-flag a line that already carries a scrub:allow marker, and what is the sanctioned response when it blocks a push?",
		gt: "The pre-push scan walks base..tip PER-COMMIT added lines; the scrub:allow exemption only checks the TIP's copy of a line (scrub-git.ts W708 note). When the offending line's marker lives in unpushed branch-base history the range walk re-flags it — every W-branch push re-flags the same line. Sanctioned response: never bypass (no SUSPENDERS_SCRUB=0, no history rewrite) — emit NEED_DECISION and let the owner/ladder resolve.",
		src: "hooks/lib/scrub-git.ts:79-120 (W700/W708), fleet lesson (2026-10-19 window)",
	},
	{
		id: "J2",
		class: "judgment",
		gt: "2026-10-12: test fixtures that copy /bin/sleep (cp'd, argv0 'codex') died instantly as defunct zombies machine-wide — no lsof cwd, liveness red with ZERO code delta. Direct /bin/sleep kept living. Not a code bug: machine state; baseline A/B proved green 20:47 → red 21:00 on identical code. Teaching: prove red is pre-existing via baseline A/B on name-set, skip/re-baseline, and note direct-BinaryObject fakes are immune.",
		q: "What did the copied-sleep fake-zombie incident teach about liveness testing?",
		src: "coord fact lesson.copied-sleep-fake-zombie + machine event log 2026-10-12",
	},
	{
		id: "J3",
		class: "judgment",
		q: "When does `work done --sha` fail with a misleading 'git rev-parse failed' and what resolves it?",
		gt: "WITHOUT --summary, work done verifies the final capsule checkpoint == the completion sha; a checkpoint=none capsule (or checkpoint that doesn't rev-parse) fails with 'Cannot verify completion commit evidence: git rev-parse failed'. Resolution: re-bank the capsule with --checkpoint=<branch-head-sha> and re-run; --summary bypasses the match.",
		src: "coord fact lesson.work-done-capsule-checkpoint + hooks/lib/work-completion-record.ts",
	},
	{
		id: "J4",
		class: "judgment",
		q: "What is the merge-ladder self-ship veto and why does it exist?",
		gt: "The ladder never merges a branch whose item is CLAIMED/RUNNING, even when the lane itself runs the merge: shipping your own lane's branch mid-flight is a silent no-op by design (a live lane owned a worktree mid-merge in the 2026-09-30 incident). Flow: close the item (work done --sha), the loop ships; verify via rev-parse main.",
		src: "hooks/lib/fleet-loop/merge.ts:99-118 + gaps incident 2026-09-30",
	},
	{
		id: "J5",
		class: "judgment",
		q: "Why do lanes wall for weeks on 'hung' 429s and what is the sanctioned cap?",
		gt: "Pre-W695.6.1 the buckle relay honored provider retry_after floors UNCAPPED — a quota wall could sleep the lane for weeks (the 'hung' 429s are this, not a dead lane). W695.6.1 caps the provider floor at retry_after_cap_s (cooldown.ts: max(provider floor, capped exponential) with floor ≤ floorCapS); the cap work is item W695.6.1.",
		src: "packages/buckle/src/cooldown.ts:14-30 + W695.6.1",
	},
];

/** Seeded per-question coin: does the banked arm's answer take slot X
 * (true) or Y (false)? Reproducible, identity-blind presentation. */
export function xyAssign(seed: number, count: number): boolean[] {
	let s = seed >>> 0;
	const rand = (): number => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
	return Array.from({ length: count }, () => rand() < 0.5);
}
