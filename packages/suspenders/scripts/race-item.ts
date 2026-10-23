#!/usr/bin/env bun
// scripts/race-item.ts — W1143: the dispatch-side face of the race policy.
// One work item → the plan dispatch would ride: lanes (>1 = race on the
// cheap tier), attempt temp, judge tier, skeptic — classified against the
// machine race policy (~/.claude/local-llm/race-policy, fail-soft chain).
// Exit 0 plan · 1 refused (parse violation, unknown item, unreadable graph).
//
//   bun scripts/race-item.ts <item-id> [--repo <dir>] [--json]
import {
	defineVerb,
	parseVerb,
	renderVerbHelp,
} from "../hooks/lib/verb-kit.ts";
import { openStore, projectIdentity } from "../hooks/lib/govdb.ts";
import { effortItemFromStore } from "../hooks/lib/lane-effort-policy.ts";
import {
	type LoadedRacePolicy,
	loadRacePolicy,
	type RaceItemInput,
	raceDecision,
	racePolicyLine,
} from "../hooks/lib/race-policy.ts";

const SPEC = defineVerb({
	name: "plan",
	usage: "usage: race-item <item-id> [--repo <dir>] [--json]",
	flags: ["--repo"],
	switches: ["--json"],
	minPos: 1,
});

/** The plan dispatch rides: the race decision plus WHERE the policy came
 *  from (env pin / runtime conf / built-in defaults) and any warning. */
export interface RacePlan {
	item: string;
	lanes: number;
	raced: boolean;
	attemptPort: number;
	attemptTemp: number;
	judgePort: number;
	skeptic: boolean;
	matched: string | null;
	source: string;
	path: string | null;
	warning: string | null;
}

/** Pure item → plan projection over a loaded policy (no graph, no env). */
export const planOf = (
	item: string,
	row: RaceItemInput,
	load: LoadedRacePolicy,
): RacePlan => {
	const d = raceDecision(load.policy, row);
	return {
		item,
		...d,
		source: load.source,
		path: load.path,
		warning: load.warning,
	};
};

/** The loosely-typed store handle (openStore's GovernorStore and bun:sqlite
 *  Database both satisfy it). */
type PlanStore = {
	query: (sql: string) => { get: (...params: unknown[]) => unknown };
};

interface PlanOpts {
	store?: PlanStore;
	env?: NodeJS.ProcessEnv;
	home?: string;
}

/** The CLI body: parse → policy → item row → plan. Injectable store/env/home
 *  for tests; production rides the real graph and machine conf. */
export const planCli = async (
	argv: string[],
	opts: PlanOpts = {},
): Promise<number> => {
	// the embedded door intercepts --help itself (runCli's job on the
	// process door): per-verb help, stdout, exit 0
	if (argv.includes("--help")) {
		console.log(renderVerbHelp(SPEC));
		return 0;
	}
	const out = parseVerb(SPEC, argv);
	if (!out.ok) {
		if (out.kind === "help") {
			console.log(out.message);
			return 0;
		}
		console.error(`race-item: ${out.message}`);
		return 1;
	}
	const item = out.parsed.pos[0];
	const repo = out.parsed.flag("--repo") ?? process.cwd();
	const load = loadRacePolicy({ env: opts.env, home: opts.home });
	try {
		const store = opts.store ?? (openStore() as unknown as PlanStore);
		const row = effortItemFromStore(store, projectIdentity(repo), item);
		if (!row) {
			console.error(`race-item: unknown item ${item} in ${repo}'s graph`);
			return 1;
		}
		const plan = planOf(item, row, load);
		if (out.parsed.all("--json").length)
			console.log(JSON.stringify(plan, null, 2));
		else {
			console.log(racePolicyLine(plan));
			console.log(
				`policy source: ${load.source}${load.path ? ` (${load.path})` : ""}`,
			);
		}
		if (plan.warning) console.error(`race-item: warn — ${plan.warning}`);
		return 0;
	} catch (e) {
		console.error(`race-item: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
};

if (import.meta.main) process.exitCode = await planCli(process.argv.slice(2));
