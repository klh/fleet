// scripts/lib/intent-reconcile.ts — W2262: stale launch-intent
// reconciliation. Incident 2026-10-29: ten REGISTERED rows in
// lane_launch_intents for DONE work items had unknown process liveness
// (foreign host, unreadable birth, executor drift) and heldLaunchItems kept
// every row that is not PROVABLY dead — the fail-closed fence that protects
// live lanes also held 10 phantom slots and refused urgent dispatch at 7/8
// with no active lane anywhere. The one-sided rule starves admission; the
// opposite one (trust the work state) would kill live lanes. The fence here
// keeps BOTH properties: a row may only be failed when the canonical work
// graph says its item is TERMINAL (no claim to protect — a live finisher
// holds its slot until it exits) AND the process verdict is not "alive".
// Unknown stays unknown for every nonterminal item — that ambiguity belongs
// to the reclaim liveness path (observeReclaim), never to this sweep; a
// claimant liveness "alive" verdict is never overridden here (the W2260
// no-blanket-reclaim bound). Every failure is a CAS on the exact row identity
// (project/item/sid/nonce/state) plus an immutable audit event.
import type { GovernorStore } from "../../hooks/lib/govdb/govdb.ts";
import type { LaunchIntent } from "./launch-fencing.ts";

export type IntentInspect = (
	intent: LaunchIntent,
) => "alive" | "dead" | "unknown";

/** Work-graph states after which no lane can legitimately hold the item. */
export const TERMINAL_WORK_STATES: readonly string[] = [
	"DONE",
	"SUPERSEDED",
	"CANCELLED",
	"FAILED",
];

export interface ReconcileDeps {
	store: GovernorStore;
	project: string;
	/** false (default) = dry-run: report candidates, flip nothing */
	act?: boolean;
	/** liveness verdict; default inspectLaunchIntent (DI for tests) */
	inspect?: IntentInspect;
	/** injectable clock for the audit events */
	now?: () => number;
	/** canonical work_items.state reader; default the store's own table */
	workState?: (item: string) => string | null;
}

export interface ReconciledIntent {
	item: string;
	sid: string;
	nonce: string;
	priorState: string;
	liveness: "dead" | "unknown";
}

export interface ReconcileReport {
	scanned: number;
	failed: ReconciledIntent[];
	/** provably alive — kept regardless of work state (never kill a live lane) */
	skippedLive: number;
	/** nonterminal item, liveness dead-or-unknown — the reclaim path's problem */
	skippedAmbiguous: number;
	failures: string[];
}

export function reconcileTerminalLaunchIntents(
	deps: ReconcileDeps,
): ReconcileReport {
	const inspect = deps.inspect ?? ((): IntentInspect => () => "unknown")();
	const now = deps.now ?? ((): number => Date.now());
	const act = deps.act ?? false;
	const workState =
		deps.workState ??
		((item: string): string | null => {
			const row = deps.store
				.query("SELECT state FROM work_items WHERE project=? AND id=?")
				.get(deps.project, item) as { state: string } | null;
			return row?.state ?? null;
		});
	const rows = deps.store
		.query(
			"SELECT * FROM lane_launch_intents WHERE project=? AND state!='FAILED'",
		)
		.all(deps.project) as LaunchIntent[];
	const report: ReconcileReport = {
		scanned: rows.length,
		failed: [],
		skippedLive: 0,
		skippedAmbiguous: 0,
		failures: [],
	};
	for (const row of rows) {
		const liveness = inspect(row);
		if (liveness === "alive") {
			report.skippedLive++;
			continue;
		}
		const state = workState(row.item);
		if (!state || !TERMINAL_WORK_STATES.includes(state)) {
			// nonterminal item: the claim may be live; ambiguity never releases
			report.skippedAmbiguous++;
			continue;
		}
		if (!act) {
			report.failed.push({
				item: row.item,
				sid: row.sid,
				nonce: row.nonce,
				priorState: row.state,
				liveness,
			});
			continue;
		}
		const changed = deps.store
			.query(
				`UPDATE lane_launch_intents SET state='FAILED' WHERE project=? AND item=? AND sid=? AND nonce=? AND state=? AND EXISTS (SELECT 1 FROM work_items w WHERE w.project=lane_launch_intents.project AND w.id=lane_launch_intents.item AND w.state IN ('DONE','SUPERSEDED','CANCELLED','FAILED'))`,
			)
			.run(deps.project, row.item, row.sid, row.nonce, row.state);
		if (changed.changes !== 1) {
			report.failures.push(
				`${row.item}: intent row changed during reconcile; left untouched`,
			);
			continue;
		}
		// advisory audit — the reconcile must survive a missing events table
		try {
			deps.store
				.query(
					"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,?,?,?,?,?)",
				)
				.run(
					now(),
					"intent-reconcile",
					"dispatch.intent.stale-failed",
					row.item,
					JSON.stringify({
						project: deps.project,
						item: row.item,
						sid: row.sid,
						nonce: row.nonce,
						priorState: row.state,
						workState: state,
						liveness,
					}),
					row.sid,
				);
		} catch {}
		report.failed.push({
			item: row.item,
			sid: row.sid,
			nonce: row.nonce,
			priorState: row.state,
			liveness,
		});
	}
	return report;
}
