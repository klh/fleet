#!/usr/bin/env bun
// hooks/bin/usage-mining.ts — W826: the weekly usage-mining maintenance task
// (W779 registry entry "usage-mining"). One pass over the buckle ledger via
// cache-drilldown (7d window): rank the worst cache offenders — enough
// requests, lowest warm-rate first — write the MiningArtifact the pulse's
// mining section reads (readMiningLines), and land a terse digest as the
// coord fact finding.usage-mining. Fail-soft: an unreadable ledger exits 0
// with a note (mining is advisory; it must never fail the heartbeat cycle).
//   bun usage-mining.ts [--no-emit]   — --no-emit skips the coord fact child
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	drilldownReport,
	type MiningArtifact,
	type MiningOffender,
	miningArtifactPath,
} from "../lib/usage/cache-drilldown.ts";
import { resolveBuckleDb } from "../lib/lanes/lane-spend.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

const MIN_REQUESTS = 20;
const TOP_N = 5;
const FACT_KEY = "finding.usage-mining";

// W669.12.3: the --no-emit switch parses through verb-kit (W651).
const mining = defineVerb({
	name: "usage-mining",
	usage: "usage: usage-mining [--no-emit]",
	switches: ["--no-emit"],
});

/** Rank lanes: ≥ MIN_REQUESTS in the window, worst warm-rate first, cost
 *  index as the tiebreak (equal coldness — the expensive one mines first). */
export function mineOffenders(nowMs = Date.now()): MiningArtifact {
	const rep = drilldownReport(
		resolveBuckleDb(),
		{ days: 7, sort: "warm-rate" },
		nowMs,
	);
	const offenders: MiningOffender[] = rep.lanes
		.filter((l) => l.requests >= MIN_REQUESTS)
		.sort((a, b) => a.warmRate - b.warmRate || b.costIndex - a.costIndex)
		.slice(0, TOP_N)
		.map((l) => ({
			lane: l.lane,
			requests: l.requests,
			warmRate: l.warmRate,
			tokens: l.tokens,
			topReason: l.reasons[0]?.reason ?? "no-reason",
		}));
	return { at: nowMs, days: 7, offenders };
}

const line = (a: MiningArtifact): string =>
	a.offenders.length === 0
		? "usage-mining: no cache offenders this week (all lanes ≥20% warm or quiet)"
		: `usage-mining: ${a.offenders
				.map(
					(o) =>
						`${o.lane} ${(o.warmRate * 100).toFixed(1)}% warm (${o.requests} req/7d, ${o.topReason})`,
				)
				.join(" · ")}`;

// fact child — 30s cap, failures logged never thrown (advisory surface)
function emitFact(text: string): boolean {
	const coord = join(import.meta.dir, "coord.ts");
	try {
		const p = Bun.spawnSync(
			[
				process.execPath,
				coord,
				"fact",
				"set",
				FACT_KEY,
				"--text",
				text,
				"--source",
				"fleet-loop",
			],
			{ stdout: "pipe", stderr: "pipe", timeout: 30_000 },
		);
		return p.exitCode === 0;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const outcome = parseVerb(mining, process.argv.slice(2));
	if (!outcome.ok) {
		console.error(outcome.message);
		process.exit(1);
	}
	const noEmit = outcome.parsed.flag("--no-emit") === "true";
	const artifact = mineOffenders();
	const path = miningArtifactPath();
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		await Bun.write(path, `${JSON.stringify(artifact)}\n`);
	} catch (e) {
		console.error(
			`usage-mining: artifact write failed: ${e instanceof Error ? e.message : e}`,
		);
	}
	const digest = line(artifact);
	console.log(digest);
	if (!noEmit) {
		const ok = emitFact(digest);
		if (!ok) console.error("usage-mining: coord fact set failed (non-fatal)");
	}
}

if (import.meta.main) await main();
