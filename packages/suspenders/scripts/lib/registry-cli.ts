// registry-cli.ts — `dispatch registry <list|prune|forget>` (W636): operator
// cleanup for dead durable-registry entries. Before this verb, a stale row
// from a dead lane could only be cleared by raw store surgery while dispatch
// refused re-dispatch with "durable registry already holds a live or unknown
// lane". Deletion is liveness-guarded end to end: an entry leaves ONLY on a
// prune warrant (W636.1) — the shared tri-state verdict "dead" (anchored
// process identity false AND claimant transcript stale — the same verdict
// the dispatch refusal check and `work lanes` trust), or the age-based trust
// below — re-verified under the registry lock. Live and young-unknown reads
// are REFUSALS, never silent skips.
import {
	defineVerb,
	parseVerb,
	renderRegistryHelp,
	renderVerbHelp,
	type Parsed,
	type VerbSpec,
} from "../../hooks/lib/verb-kit.ts";
import { pruneLaneRegistry } from "../../hooks/lib/lane-registry.ts";
import { laneVerdict, type LaneRef } from "../../hooks/lib/lane-liveness.ts";
import { loadLanes, type Lane } from "./lane.ts";

// W651: the verb registry owns the surface — help is generated, parsing rides
// the kit's pure door (this is an embedded main: the caller owns exit codes).
const VERBS: VerbSpec[] = [
	defineVerb({
		name: "list",
		usage: "usage: list [--json] — entries + liveness verdicts",
		switches: ["--json"],
		lax: true,
	}),
	defineVerb({
		name: "prune",
		usage:
			"usage: prune --sid <sid> [--sid ...] [--dry-run] | prune --all-dead [--dry-run]",
		flags: ["--sid"],
		switches: ["--dry-run", "--all-dead"],
		lax: true,
	}),
	defineVerb({
		name: "forget",
		usage: "usage: forget --sid <sid> [--sid ...] — alias of prune",
		flags: ["--sid"],
		switches: ["--dry-run"],
		lax: true,
	}),
];

export type PruneClass =
	| "prunable"
	| "refused-live"
	| "refused-unknown"
	| "absent";

export type PrunePlan = Map<
	string,
	{ class: PruneClass; row?: Lane; warrant?: PruneWarrant }
>;

/** W636.1 age-based trust: an UNKNOWN verdict with NO process id ever
 * recorded (pid=0/absent — the dispatch recovery path stamps placeholder
 * identities, never processes) and older than 24h is prunable. The unknown
 * verdict already proves the claimant transcript cold; pid-less proves the
 * process probe has nothing to mis-kill; age proves nothing is waiting on
 * the entry. Live and young-unknown entries keep full protection. */
export const UNKNOWN_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

/** Why a row may leave the registry: "dead" = shared verdict dead;
 * "age-trusted" = unknown + pid-less + >24h. Null = protected. */
export type PruneWarrant = "dead" | "age-trusted";
export const pruneWarrant = (
	row: Lane,
	v: "alive" | "dead" | "unknown",
	now: number,
): PruneWarrant | null => {
	if (v === "dead") return "dead";
	if (
		v === "unknown" &&
		!row.pid &&
		now - (row.launchedAt ?? 0) >= UNKNOWN_PRUNE_AGE_MS
	)
		return "age-trusted";
	return null;
};

/** Pure prune classification — verdictOf injects the shared liveness surface
 * so tests need no process table; now injects the clock (determinism in
 * tests). */
export const classifyPrune = (
	rows: Lane[],
	sids: string[],
	verdictOf: (l: LaneRef) => "alive" | "dead" | "unknown",
	now: number = Date.now(),
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
		const warrant = pruneWarrant(row, v, now);
		if (warrant) {
			plan.set(sid, { row, warrant, class: "prunable" });
			continue;
		}
		plan.set(sid, {
			row,
			class: v === "alive" ? "refused-live" : "refused-unknown",
		});
	}
	return plan;
};

const fmtRow = (r: Lane): string =>
	`${laneVerdict(r)}  ${r.sid}  item=${r.item}  pid=${r.pid ?? "-"}  host=${r.host ?? "-"}  launched=${r.launchedAt ? new Date(r.launchedAt).toISOString() : "-"}`;

const listVerb = (parsed: Parsed, fleet: string): number => {
	const rows = loadLanes(fleet);
	if (parsed.flag("--json") === "true") {
		const now = Date.now();
		console.log(
			JSON.stringify(
				rows.map((r) => {
					const verdict = laneVerdict(r);
					return {
						...r,
						verdict,
						prunable: pruneWarrant(r, verdict, now) !== null,
					};
				}),
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
		console.log(
			c.warrant === "age-trusted"
				? `PRUNED ${sid} — age-trusted unknown: no pid ever recorded, >24h (item ${c.row?.item})`
				: `PRUNED ${sid} — dead lane entry (item ${c.row?.item})`,
		);
	else if (c.class === "refused-live")
		console.log(`RETAINED ${sid} — live lane (probe confirmed); entry stays`);
	else
		console.log(
			`RETAINED ${sid} — unknown liveness (probe uncertain; never force-pruned)`,
		);
};

/** Parse + classify a prune request. Null = usage error (help printed). */
const prunePlanFor = (
	parsed: Parsed,
	fleet: string,
): {
	dry: boolean;
	now: number;
	plan: PrunePlan;
	requested: string[];
} | null => {
	const dry = parsed.flag("--dry-run") === "true";
	const allDead = parsed.flag("--all-dead") === "true";
	const explicit = parsed.all("--sid").filter((v) => v.length > 0);
	if (!allDead && !explicit.length) {
		console.log(USAGE);
		return null;
	}
	const now = Date.now();
	const rows = loadLanes(fleet);
	const wanted = [
		...new Set(allDead ? [...explicit, ...rows.map((r) => r.sid)] : explicit),
	];
	const plan = classifyPrune(rows, wanted, laneVerdict, now);
	const requested = [...plan]
		.filter(([, c]) => c.class === "prunable")
		.map(([sid]) => sid);
	return { dry, now, plan, requested };
};

const pruneVerb = (parsed: Parsed, fleet: string): number => {
	const ask = prunePlanFor(parsed, fleet);
	if (!ask) return 2;
	const { dry, now, plan, requested } = ask;
	for (const [sid, c] of plan) printPruneVerdict(sid, c, dry);
	if (dry) return 0;
	const result = pruneLaneRegistry(
		fleet,
		requested,
		(row) => pruneWarrant(row, laneVerdict(row), now) !== null,
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

// generated help: about + registry verbs + the W636.1 warrant prose
const EPILOG = `An entry is prunable on a prune warrant (W636.1): the shared liveness
verdict "dead" — recorded pid gone (or never recorded) with anchored
harness args absent AND the claimant transcript stale past the 15-min
reclaim lease — OR age-based trust: verdict "unknown" AND no pid ever
recorded (pid=0/absent) AND the entry launched >24h ago. Live entries and
young-unknown entries RETAIN — age trust never overrides a live verdict or
a recorded pid.
Exit codes: 0 pruned/clean, 1 refused (live/young-unknown retained), 2 usage.`;

const HELP = renderRegistryHelp(
	"dispatch registry",
	"Usage: dispatch registry <verb> [options] — inspect and prune the durable lane registry (.fleet/lanes.json).",
	VERBS,
	`${VERBS.map((v) => renderVerbHelp(v))
		.filter(Boolean)
		.join("\n")}\n\n${EPILOG}`,
);

/** `dispatch registry <verb>` entrypoint — returns the process exit code. */
export const registryMain = (
	args: string[],
	ctx: { fleet: string },
): number => {
	const [verb = "", ...rest] = args;
	if (!verb || verb === "help") {
		console.log(HELP);
		return verb ? 0 : 2;
	}
	const spec = VERBS.find((v) => v.name === verb);
	if (!spec) {
		console.log(HELP);
		return 2;
	}
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(renderVerbHelp(spec) || HELP);
		return 0;
	}
	const outcome = parseVerb(spec, rest);
	if (!outcome.ok) {
		console.log(HELP);
		return 2;
	}
	const parsed = outcome.parsed;
	if (spec.name === "list") return listVerb(parsed, ctx.fleet);
	return pruneVerb(parsed, ctx.fleet);
};
