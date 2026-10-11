// registry-cli.ts — `dispatch registry <list|prune|forget>` (W636): operator
// cleanup for dead durable-registry entries. Before this verb, a stale row
// from a dead lane could only be cleared by raw store surgery while dispatch
// refused re-dispatch with "durable registry already holds a live or unknown
// lane". Deletion is liveness-guarded end to end: an entry leaves ONLY on
// the shared tri-state verdict "dead" (anchored process identity false AND
// claimant transcript stale — the same verdict the dispatch refusal check
// and `work lanes` trust), re-verified under the registry lock. Live and
// unknown reads are REFUSALS, never silent skips.
import { pruneLaneRegistry } from "../../hooks/lib/lane-registry.ts";
import { laneVerdict, type LaneRef } from "../../hooks/lib/lane-liveness.ts";
import { loadLanes, type Lane } from "./lane.ts";

const USAGE = `Usage: dispatch registry <verb> [options]

Inspect and prune the durable lane registry (.fleet/lanes.json).

  list [--json]                       Print entries + liveness verdicts
  prune --sid <sid> [--sid ...]       Remove entries whose lane is provably dead
  forget --sid <sid> [--sid ...]      Alias of prune
  prune --all-dead [--dry-run]        Sweep every provably-dead entry
  --dry-run                           Classify without writing
  -h, --help                          Print this help

An entry is prunable only when the shared liveness verdict reads "dead":
recorded pid gone (or never recorded) with anchored harness args absent AND
the claimant transcript stale past the 15-min reclaim lease. Live and
unknown verdicts RETAIN the entry — unknown never authorizes deletion.
Exit codes: 0 pruned/clean, 1 refused (live/unknown retained), 2 usage.`;

export type PruneClass =
	| "prunable"
	| "refused-live"
	| "refused-unknown"
	| "absent";

export type PrunePlan = Map<string, { class: PruneClass; row?: Lane }>;

/** Pure prune classification — verdictOf injects the shared liveness surface
 * so tests need no process table. */
export const classifyPrune = (
	rows: Lane[],
	sids: string[],
	verdictOf: (l: LaneRef) => "alive" | "dead" | "unknown",
): PrunePlan => {
	const plan: PrunePlan = new Map();
	const bySid = new Map(rows.map((r) => [r.sid, r]));
	for (const sid of sids) {
		const row = bySid.get(sid);
		if (!row) {
			plan.set(sid, { class: "absent" });
			continue;
		}
		const v = verdictOf(row);
		plan.set(sid, {
			row,
			class:
				v === "dead"
					? "prunable"
					: v === "alive"
						? "refused-live"
						: "refused-unknown",
		});
	}
	return plan;
};

const fmtRow = (r: Lane): string =>
	`${r.sid}  item=${r.item}  pid=${r.pid ?? "-"}  host=${r.host ?? "-"}  launched=${r.launchedAt ? new Date(r.launchedAt).toISOString() : "-"}`;

const listVerb = (args: string[], fleet: string): number => {
	const rows = loadLanes(fleet);
	if (args.includes("--json")) {
		console.log(
			JSON.stringify(
				rows.map((r) => ({ ...r, verdict: laneVerdict(r) })),
				null,
				2,
			),
		);
		return 0;
	}
	for (const r of rows) console.log(fmtRow(r));
	console.log(
		`${rows.length} entr${rows.length === 1 ? "y" : "ies"} in ${fleet}/lanes.json`,
	);
	return 0;
};

const printPruneVerdict = (
	sid: string,
	c: { class: PruneClass; row?: Lane },
	dry: boolean,
): void => {
	if (c.class === "absent") {
		console.log(`NO ENTRY ${sid}`);
		return;
	}
	if (dry) {
		console.log(
			`WOULD ${c.class === "prunable" ? "PRUNE" : "RETAIN"} ${sid} — ${c.class}`,
		);
		return;
	}
	if (c.class === "prunable")
		console.log(`PRUNED ${sid} — dead lane entry (item ${c.row?.item})`);
	else if (c.class === "refused-live")
		console.log(`RETAINED ${sid} — live lane (probe confirmed); entry stays`);
	else
		console.log(
			`RETAINED ${sid} — unknown liveness (probe uncertain; never force-pruned)`,
		);
};

const flagValues = (args: string[], flag: string): string[] => {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++)
		if (args[i] === flag) out.push(args[++i] ?? "");
	return out.filter((v) => v.length > 0);
};

/** Parse + classify a prune request. Null = usage error (help printed). */
const prunePlanFor = (
	args: string[],
	fleet: string,
): { dry: boolean; plan: PrunePlan; requested: string[] } | null => {
	const dry = args.includes("--dry-run");
	const allDead = args.includes("--all-dead");
	const explicit = flagValues(args, "--sid");
	if (!allDead && !explicit.length) {
		console.log(USAGE);
		return null;
	}
	const rows = loadLanes(fleet);
	const wanted = [
		...new Set(allDead ? [...explicit, ...rows.map((r) => r.sid)] : explicit),
	];
	const plan = classifyPrune(rows, wanted, laneVerdict);
	const requested = [...plan]
		.filter(([, c]) => c.class === "prunable")
		.map(([sid]) => sid);
	return { dry, plan, requested };
};

const pruneVerb = (args: string[], fleet: string): number => {
	const parsed = prunePlanFor(args, fleet);
	if (!parsed) return 2;
	const { dry, plan, requested } = parsed;
	for (const [sid, c] of plan) printPruneVerdict(sid, c, dry);
	if (dry) return 0;
	const result = pruneLaneRegistry(
		fleet,
		requested,
		(row) => laneVerdict(row) === "dead",
	);
	const removed = new Set(result.removed.map((r) => r.sid));
	for (const sid of requested)
		if (!removed.has(sid))
			console.log(
				`RETAINED ${sid} — went live between probe and prune (under-lock re-check)`,
			);
	const absent = [...plan.values()].filter((c) => c.class === "absent").length;
	const refused = [...plan.values()].filter((c) =>
		c.class.startsWith("refused-"),
	).length;
	console.log(
		`registry prune: ${result.removed.length} pruned, ${refused + (requested.length - result.removed.length)} retained, ${absent} absent`,
	);
	return refused > 0 ? 1 : 0;
};

/** `dispatch registry <verb>` entrypoint — returns the process exit code. */
export const registryMain = (
	args: string[],
	ctx: { fleet: string },
): number => {
	const [verb = "", ...rest] = args;
	if (!verb || verb === "-h" || verb === "--help" || verb === "help") {
		console.log(USAGE);
		return verb ? 0 : 2;
	}
	if (verb === "list") return listVerb(rest, ctx.fleet);
	if (verb === "prune" || verb === "forget") return pruneVerb(rest, ctx.fleet);
	console.log(USAGE);
	return 2;
};
