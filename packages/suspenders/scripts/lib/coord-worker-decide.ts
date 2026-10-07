// scripts/lib/coord-worker-decide.ts — W529: the PURE coord-worker decisions
// and the coordinator bootstrap text. The impure readers (fact read, transcript
// probe, front probe, mint) live in scripts/coord-worker.ts; every branch of
// the run decision is unit-testable here. Bounds (mission W529): no
// outward-facing actions, never resolves a NEED_DECISION (surfaces only), at
// most ONE item per run, exits cleanly so KeepAlive is never needed.

/** The worker's stable identity — consults and board messages addressed to
 *  `coordworker` survive across runs and iTerm closing. */
export const COORD_WORKER_SID = "coordworker";

/** The work-item tag that marks an item coordinator-class. */
export const COORD_TAG = "coord";

/** The fact the on-duty INTERACTIVE coordinator publishes (govdb lanes.ts);
 *  a warm transcript on that sid means coordination is covered right now. */
export const COORDINATOR_SID_FACT = "coordinator.sid";

export type CoordRunDecision =
	| { mode: "skip-live"; why: string }
	| { mode: "refuse"; why: string }
	| { mode: "run"; why: string };

/** One decision per fire (pure): the on-duty interactive coordinator stands
 *  in front of the worker (its transcript warm ≤15min = coordination is
 *  covered NOW — a duplicate drain only double-replies consults); otherwise
 *  the governed path is fail-closed — front down or mint failed refuses the
 *  run (same posture as W463 dispatch; the next fire retries). */
export const coordRunDecision = (o: {
	coordinatorLive: boolean;
	frontUp: boolean;
	minted: { key: string; keyId: string } | null;
}): CoordRunDecision => {
	if (o.coordinatorLive)
		return {
			mode: "skip-live",
			why: "coordinator.sid transcript warm (≤15 min) — interactive coordinator on duty; standing down this fire",
		};
	if (!o.frontUp)
		return {
			mode: "refuse",
			why: "buckle front unreachable — the governed path is the point (fail-closed, W463 posture); next fire retries",
		};
	if (!o.minted)
		return {
			mode: "refuse",
			why: "buckle lane-key mint failed — check belt.env BUCKLE_ADMIN_KEY (fail-closed, W463 posture); next fire retries",
		};
	return {
		mode: "run",
		why: "front up, key minted, no live interactive coordinator — governed run goes",
	};
};

/** Coordinator-class marker: the item's tags value contains the coord tag
 *  (work_items.tags is one TEXT cell — comma/space lists both count). */
export const isCoordinatorItem = (tags: string | null | undefined): boolean =>
	typeof tags === "string" &&
	tags
		.split(/[,\s]+/)
		.map((t) => t.trim())
		.includes(COORD_TAG);

/** Parse `work ready` renderRow output (ANSI-stripped): glyph, id, title,
 *  trailing `#<tags>`. Rows without the coord tag are returned too — the
 *  caller filters via isCoordinatorItem so both halves stay testable. */
export const parseCoordReady = (
	stdout: string,
): { id: string; title: string; tags: string | null }[] =>
	stdout
		.split("\n")
		.map((l) => /^[·*\s]*(W[\d.]+)\s+(.+?)(?:\s+#(\S+))?\s*$/.exec(stripAnsi(l)))
		.map((m) =>
			m
				? { id: m[1], title: m[2].trim(), tags: m[3] ?? null }
				: null,
		)
		.filter((x): x is { id: string; title: string; tags: string | null } => !!x);

const stripAnsi = (s: string): string =>
	s.replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
		"",
	);

/** The coordinator bootstrap — the headless session's entire mission: drain,
 *  sweep, at most one item, capsule, exit. The bounds section is the load-
 *  bearing part; keep every bound verbatim. */
export const coordBootstrap = (o: {
	sid: string;
	repo: string;
	bin: string;
	model: string;
}): string => `You are "${o.sid}", the fleet's headless coordinator — launchd label com.suspenders.coord-worker fires this governed run every 900s (niced; one process per fire). Repo root ${o.repo}. English only.

IDENTITY: executor ${o.model} via the buckle front /w/${o.sid} (scoped bksk_ key minted for THIS run, revoked at exit).

RUN BOUNDS — violating any of these fails the run:
- NO outward-facing actions: no email/SMTP, no web posts, no external sends — nothing leaves the machine. All coordination stays on the local plane.
- NEVER resolve a decision: no board /api/ack or /api/answer on a NEED_DECISION event, no resolution emit. Surface, don't resolve: bun ${o.bin}/coord.ts emit NEED_DECISION --to <responsible-sid> --note "question + options" --as ${o.sid}.
- AT MOST ONE item this run.
- EXIT CLEANLY: bank the capsule and end — launchd re-fires in 900s. No daemons, no background jobs left behind.

RUN PLAN:
1. Drain: bun ${o.bin}/coord.ts inbox --as ${o.sid} (your inbox is WS-pushed via the session subscribe — one drain, never polling). Consults addressed to you: reply with bun ${o.bin}/coord.ts consult-reply <C#> --feedback resolved|failed|unused --evidence "<command and observed result>". Fleet-wide consults you can answer from coord facts: reply; unsure = surface, never guess. Board messages: act, or surface as NEED_DECISION.
2. Plane sweep: bun ${o.bin}/coord.ts fleet — who is working. Dead-claim cleanup is allowed, evidence-backed only: bun ${o.bin}/work.ts reclaim all (claims → READY). Broadcast only a landed change that affects lanes.
3. One item: bun ${o.bin}/work.ts ready — coordinator-class = rows tagged #${COORD_TAG}. If one is claimable: bun ${o.bin}/work.ts take <id> --as ${o.sid} (a lost take-race ends the run, cleanly). Then bun ${o.repo}/packages/suspenders/hooks/bin/worktree.ts create <id> and work it in .worktrees/<id> on branch suspenders/<id>: read the repo's AGENTS.md FIRST (plan-first, shatter judgment, gates, done protocol), co-situated tests, capsule at every boundary, commit (subject = item id), finish bun ${o.bin}/work.ts done <id> --sha <branch-head>, land a finding fact. Intellectual work: inbox triage, consult synthesis, plan items — surfaces decisions, never owns them.
4. Capsule at every boundary (the LAST capsule is the hand-off): bun ${o.bin}/coord.ts capsule set --as ${o.sid} --checkpoint=<branch-head-sha|none> --done="<done>" --next="<next>".
5. End when drained and the item (if any) is landed or parked with a capsule. Final line: DONE <sha> | SPLIT <id> | BLOCKED (3 honest attempts) | IDLE (nothing to do).

PROTOCOL: BEFORE any edit, read AGENTS.md in the repo root and follow it. REPORT VERDICTS: report-shaped output ends with ONE machine-parseable verdict line (VERDICT: PASS | FAIL, APPROVED | NEEDS REVISION, CLEAR | GAPS_FOUND).
`;
