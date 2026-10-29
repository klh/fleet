import type { GovernorStore } from "../lib/govdb/govdb.ts";
import {
	type LaneRef,
	laneProcessIdentity,
	laneVerdict,
	type ProcessInspection,
	transcriptsAliveBatch,
} from "../lib/lanes/lane-liveness.ts";
import {
	memoProjectRoot,
	newerLane,
	readLaneRegistry,
} from "../lib/lanes/lane-registry.ts";
import {
	type ExecutionClaim,
	type ExecutionEvidence,
	workExecution,
} from "../lib/work/work-execution.ts";
import { artifactEvidence } from "./artifact-events.ts";
import { boardKnob } from "./board-knobs.ts";

type Registered = LaneRef & { attempt?: number };

// One `ps` per window, not per /api/tasks compute: a process table
// SUSPENDERS_BOARD_PS_MEMO_MS (default 2000) old reads the same liveness —
// lease verdicts already tolerate transcript/heartbeat lag far above that.
let _ps: { at: number; inspection: ProcessInspection } | null = null;

function processTable(now: number): ProcessInspection {
	const ttl = boardKnob("board.ps_memo_ms");
	if (_ps && now - _ps.at < ttl && now >= _ps.at) return _ps.inspection;
	const ps = Bun.spawnSync(["ps", "-axo", "pid=,args="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const inspection = { exitCode: ps.exitCode, stdout: ps.stdout.toString() };
	_ps = { at: now, inspection };
	return inspection;
}

/** One read snapshot for the whole feed. No per-card process/store probe. */
export function taskExecutionSnapshot(
	db: GovernorStore,
	claims: readonly ExecutionClaim[],
	now = Date.now(),
) {
	const inspection = processTable(now);
	const inspect = () => inspection;
	const facts = new Map(
		(
			db
				.query("SELECT key, value, ts FROM facts WHERE key LIKE 'lane.%.state'")
				.all() as { key: string; value: string; ts: number }[]
		).map((f) => [f.key, f]),
	);
	const lanes = new Map<string, ExecutionEvidence>();
	const claimed = new Set(
		claims.map((c) => `${c.project}\0${c.id}\0${c.owner_sid}`),
	);
	// W2273 follow-up: collect first, then ONE bounded transcript walk for
	// every claimed lane — the per-row laneVerdict walk re-read the whole
	// ~/.claude/projects tree once per dead lane (negatives never memoize),
	// which pinned the board's event loop on /api/tasks.
	const pending: {
		project: string;
		row: Registered;
		lifecycle: { value: string; ts: number } | null;
	}[] = [];
	for (const project of new Set(claims.map((c) => c.project))) {
		try {
			const registry = readLaneRegistry<Registered>(project, memoProjectRoot);
			if (!registry.known) continue;
			const latest = new Map<string, Registered>();
			for (const row of registry.lanes) {
				const key = `${row.item}\0${row.sid}`;
				const previous = latest.get(key);
				latest.set(key, previous ? newerLane(previous, row) : row);
			}
			for (const row of latest.values()) {
				if (!claimed.has(`${project}\0${row.item}\0${row.sid}`)) continue;
				const recorded = facts.get(`lane.${row.sid}.state`);
				const lifecycle =
					recorded && recorded.ts >= (row.launchedAt ?? 0) ? recorded : null;
				pending.push({ project, row, lifecycle });
			}
		} catch {
			/* Missing/remote registry remains unknown, never dead. */
		}
	}
	const transcripts = transcriptsAliveBatch(pending.map((p) => p.row.sid));
	for (const { project, row, lifecycle } of pending)
		lanes.set(`${project}\0${row.item}\0${row.sid}`, {
			project,
			item: row.item,
			sid: row.sid,
			observedAt: now,
			process: laneProcessIdentity(row, inspect),
			lease: laneVerdict(row, inspect, transcripts),
			lifecycle: lifecycle?.value ?? null,
			lifecycleAt: lifecycle?.ts ?? null,
			attempt: row.attempt ?? null,
		});
	const artifacts = artifactEvidence(db);
	return (claim: ExecutionClaim) =>
		workExecution(
			claim,
			lanes.get(`${claim.project}\0${claim.id}\0${claim.owner_sid}`) ?? null,
			artifacts,
			now,
		);
}
