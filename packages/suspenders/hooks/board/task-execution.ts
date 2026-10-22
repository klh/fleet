import type { GovernorStore } from "../lib/govdb.ts";
import {
	laneProcessIdentity,
	laneVerdict,
	type LaneRef,
	type ProcessInspection,
} from "../lib/lane-liveness.ts";
import { readLaneRegistry, newerLane } from "../lib/lane-registry.ts";
import {
	workExecution,
	type ArtifactEvidence,
	type ExecutionClaim,
	type ExecutionEvidence,
} from "../lib/work-execution.ts";

type Registered = LaneRef & { attempt?: number };
type Event = {
	ts: number;
	kind: string;
	project: string | null;
	work: string | null;
	payload: string | null;
};

/** One read snapshot for the whole feed. No per-card process/store probe. */
export function taskExecutionSnapshot(
	db: GovernorStore,
	claims: readonly ExecutionClaim[],
	now = Date.now(),
) {
	const process = Bun.spawnSync(["ps", "-axo", "pid=,args="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const inspection: ProcessInspection = {
		exitCode: process.exitCode,
		stdout: process.stdout.toString(),
	};
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
	for (const project of new Set(claims.map((c) => c.project))) {
		try {
			const registry = readLaneRegistry<Registered>(project);
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
				lanes.set(`${project}\0${row.item}\0${row.sid}`, {
					project,
					item: row.item,
					sid: row.sid,
					observedAt: now,
					process: laneProcessIdentity(row, inspect),
					lease: laneVerdict(row, inspect),
					lifecycle: lifecycle?.value ?? null,
					lifecycleAt: lifecycle?.ts ?? null,
					attempt: row.attempt ?? null,
				});
			}
		} catch {
			/* Missing/remote registry remains unknown, never dead. */
		}
	}
	const artifacts: ArtifactEvidence[] = [];
	for (const event of db
		.query(
			"SELECT ts, kind, project, work, payload FROM events WHERE kind IN ('work.done','work.review','work.landed') ORDER BY id DESC LIMIT 5000",
		)
		.all() as Event[]) {
		try {
			const payload = JSON.parse(event.payload ?? "{}");
			const receipt =
				event.kind === "work.review"
					? JSON.parse(payload.receipt ?? "null")
					: null;
			const commit = receipt?.commit ?? payload.commit ?? payload.sha;
			const project = event.project ?? payload.project;
			const item = event.work ?? payload.work;
			if (
				typeof commit !== "string" ||
				typeof project !== "string" ||
				typeof item !== "string"
			)
				continue;
			if (
				event.kind === "work.review" &&
				!["PASS", "FAIL", "ERROR"].includes(receipt?.verdict)
			)
				continue;
			artifacts.push({
				project,
				item,
				commit,
				ts: event.ts,
				stage:
					event.kind === "work.landed"
						? "landed"
						: event.kind === "work.done"
							? "completed"
							: receipt.verdict === "PASS"
								? "reviewed"
								: "review-blocked",
			});
		} catch {
			/* Unbound/legacy prose cannot become artifact evidence. */
		}
	}
	return (claim: ExecutionClaim) =>
		workExecution(
			claim,
			lanes.get(`${claim.project}\0${claim.id}\0${claim.owner_sid}`) ?? null,
			artifacts,
			now,
		);
}
