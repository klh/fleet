#!/usr/bin/env bun
// hooks/bin/usage-mining.ts — W826: the weekly usage-mining maintenance task
// (W779 registry entry "usage-mining"). One pass over the buckle ledger via
// cache-drilldown, ranked by the W1201 cursor window — [last CONFIRMED
// cursor, now], legacy 7d fallback before the first confirmed run — so a
// late run covers the gap and an early run never re-mines confirmed data.
// Ranks the worst cache offenders — enough requests, lowest warm-rate first
// — writes the MiningArtifact the pulse's mining section reads
// (readMiningLines), and lands a terse digest as the coord fact
// finding.usage-mining. Doctrine (W1201): a maybe-ran marker is stamped
// before mining and the cursor advances ONLY after the artifact write is
// confirmed; an unavailable ledger is a NOTICE (sweep-state channel), never
// a quiet "no offenders" skip. Fail-soft: it must never fail the heartbeat.
//   bun usage-mining.ts [--no-emit]   — --no-emit skips the coord fact child
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	drilldownReport,
	type MiningArtifact,
	type MiningOffender,
	miningArtifactPath,
} from "../lib/cache-drilldown.ts";
import {
	appendSweepNotice,
	confirmCursor,
	confirmedMs,
	markMaybeRan,
	readCursor,
	sweepStateDir,
} from "../lib/fleet-loop/sweep-state.ts";
import { resolveBuckleDb } from "../lib/lane-spend.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

const MIN_REQUESTS = 20;
const TOP_N = 5;
const FACT_KEY = "finding.usage-mining";
const FALLBACK_WINDOW_MS = 7 * 86_400_000;
const cursorPath = (): string => join(sweepStateDir(), "usage-mining-cursor.json");

// W669.12.3: the --no-emit switch parses through verb-kit (W651).
const mining = defineVerb({
	name: "usage-mining",
	usage: "usage: usage-mining [--no-emit]",
	switches: ["--no-emit"],
});

/** Rank lanes: ≥ MIN_REQUESTS in the window, worst warm-rate first, cost
 *  index as the tiebreak (equal coldness — the expensive one mines first).
 *  W1201 window: [fromMs, nowMs] — the confirmed-cursor window; the legacy
 *  7d fallback applies only before the first confirmed run. */
export function mineOffenders(
	nowMs = Date.now(),
	fromMs?: number,
): MiningArtifact {
	const from = fromMs ?? nowMs - FALLBACK_WINDOW_MS;
	const rep = drilldownReport(
		resolveBuckleDb(),
		{
			from: new Date(from).toISOString(),
			to: new Date(nowMs).toISOString(),
			sort: "warm-rate",
		},
		nowMs,
	);
	if (!rep.available)
		appendSweepNotice(
			"usage-mining",
			`fail(ledger-unavailable) — cursor NOT advanced (${resolveBuckleDb() ?? "no ledger"})`,
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
	return { at: nowMs, days: (nowMs - from) / 86_400_000, offenders };
}

const line = (a: MiningArtifact): string =>
	a.offenders.length === 0
		? "usage-mining: no cache offenders this window (all lanes ≥20% warm or quiet)"
		: `usage-mining: ${a.offenders
				.map(
					(o) =>
						`${o.lane} ${(o.warmRate * 100).toFixed(1)}% warm (${o.requests} req/${Math.max(1, Math.round(a.days))}d, ${o.topReason})`,
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
	const now = Date.now();
	const runId = crypto.randomUUID();
	const cPath = cursorPath();
	// W1201: unclear-outcome marker BEFORE acting; the window starts at the
	// last CONFIRMED cursor (legacy 7d fallback pre-first-run).
	markMaybeRan(cPath, runId);
	const cursor = readCursor(cPath);
	const fromMs = confirmedMs(cursor, now - FALLBACK_WINDOW_MS);
	const artifact = mineOffenders(now, fromMs);
	const path = miningArtifactPath();
	let written = false;
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		await Bun.write(path, `${JSON.stringify(artifact)}\n`);
		written = true;
	} catch (e) {
		console.error(
			`usage-mining: artifact write failed: ${e instanceof Error ? e.message : e}`,
		);
	}
	if (written) {
		// record-only-after-confirmation: the cursor advances ONLY here
		confirmCursor(cPath, now, runId);
	} else {
		appendSweepNotice("usage-mining", "fail(artifact-write) — cursor NOT advanced");
	}
	const digest = line(artifact);
	console.log(digest);
	if (!noEmit) {
		const ok = emitFact(digest);
		if (!ok) console.error("usage-mining: coord fact set failed (non-fatal)");
	}
}

if (import.meta.main) await main();
