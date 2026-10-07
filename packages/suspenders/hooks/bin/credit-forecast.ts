#!/usr/bin/env bun
// hooks/bin/credit-forecast.ts — CLI face of the W566 premium-credit
// headroom forecast. The plan counter is authoritative; tokens are never
// inferred to be credits, no reset ETA is ever invented.
//
//   bun credit-forecast.ts sample --used 29986 --limit 50000 \
//       --plan business --multipliers "opus=15,sonnet=1" \
//       [--source dashboard] [--note "..."] [--db <samples.jsonl>]
//   bun credit-forecast.ts forecast [--json] [--act] [--db <samples.jsonl>]
//       [--queued N] [--cost-per-item F] [--horizon-hours H]
//       [--overage-permitted|--no-overage] [--overage-cost F] [--dedupe-hours H]
//
// sample records one authoritative counter read (bounded JSONL history);
// forecast reports burn/remaining/runway + the queued-work budget and exits
// 0 OK / 1 WARN / 2 UNKNOWN (quota-window parity). --act performs the
// dedupe-gated alert (bus emit + broadcast + copilot.credits.headroom fact).
import {
	appendSample,
	assess,
	envPolicy,
	forecastHeadroom,
	forecastPush,
	loadSamples,
	mergePolicy,
	parseMultipliers,
	policyFromArgv,
	sampleLine,
	statePathDefault,
	samplesPathDefault,
} from "../lib/credit-forecast.ts";

const argv = process.argv.slice(2);
const verb = argv[0] === "sample" ? "sample" : "forecast";
const val = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (msg: string): never => {
	console.error(msg);
	process.exit(2);
};

const runSample = (): void => {
	const used = val("--used");
	const limit = val("--limit");
	if (used === undefined || limit === undefined)
		fail("usage: sample --used N --limit M --plan <plan> [--multipliers k=v,...] [--source s] [--note ...] [--db path]");
	const u = Number(used);
	const l = Number(limit);
	if (!Number.isFinite(u) || !Number.isFinite(l))
		fail("sample needs finite --used and --limit (credits, never inferred from tokens)");
	const db = val("--db") ?? samplesPathDefault();
	const sample = {
		at: Date.now(),
		used: u,
		limit: l,
		plan: val("--plan") ?? "unknown",
		multipliers: val("--multipliers") ? parseMultipliers(val("--multipliers") ?? "") : {},
		source: val("--source") ?? "manual",
		...(val("--note") !== undefined ? { note: val("--note") } : {}),
	};
	appendSample(db, sample);
	console.log(`sampled: ${sampleLine(sample)}`);
};
const runForecast = (): void => {
	const db = val("--db") ?? samplesPathDefault();
	const policy = mergePolicy(
		DEFAULT_POLICY,
		mergePolicy(envPolicy(), policyFromArgv(argv)),
	);
	const f = forecastHeadroom(loadSamples(db), {});
	const a = assess(f, policy);
	const json = argv.includes("--json");
	if (json)
		console.log(
			JSON.stringify({ verdict: a.verdict, forecast: f, lines: a.lines }, null, 2),
		);
	else for (const l of a.lines) console.log(l);
	if (argv.includes("--act")) {
		const line = forecastPush({
			act: true,
			samplesPath: db,
			statePath: val("--state") ?? statePathDefault(),
			policy,
		});
		if (line !== null) console.log(`act: ${line}`);
	}
	process.exit(a.verdict === "OK" ? 0 : a.verdict === "WARN" ? 1 : 2);
};

const dedupeHours = (): number | undefined => {
	const h = val("--dedupe-hours");
	if (h === undefined) return undefined;
	const n = Number(h);
	return Number.isFinite(n) ? n * 3_600_000 : undefined;
};
if (verb === "sample") {
	runSample();
	// a fresh authoritative read immediately re-evaluates the push: same
	// path the dispatch loop takes, so a warning lands the same turn
	const line = forecastPush({
		act: true,
		samplesPath: val("--db") ?? samplesPathDefault(),
		statePath: val("--state") ?? statePathDefault(),
		policy: mergePolicy(envPolicy(), policyFromArgv(argv)),
		dedupeMs: dedupeHours(),
	});
	if (line !== null) console.log(`forecast: ${line}`);
	process.exit(0);
}
runForecast();
