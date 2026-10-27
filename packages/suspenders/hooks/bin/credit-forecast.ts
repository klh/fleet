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
	DEFAULT_POLICY,
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
} from "../lib/usage/credit-forecast.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderRegistryHelp,
	type Parsed,
	type VerbSpec,
} from "../lib/verb-kit.ts";

const die = dieFor("credit-forecast");

// W656.2: kit-owned parse — forecast stays the DEFAULT verb (verb-less
// invocation rides forecast); --help renders from the registry
const FLAGS = [
	"--used",
	"--limit",
	"--plan",
	"--multipliers",
	"--source",
	"--note",
	"--db",
	"--state",
	"--queued",
	"--cost-per-item",
	"--horizon-hours",
	"--overage-cost",
	"--dedupe-hours",
];
const SWITCHES = ["--json", "--act", "--overage-permitted", "--no-overage"];

const SAMPLE = defineVerb({
	name: "sample",
	usage:
		"usage: sample --used N --limit M --plan <plan> [--multipliers k=v,...] [--source s] [--note ...] [--db path] [--state path]",
	reqFlags: ["--used", "--limit"],
	flags: FLAGS,
	switches: SWITCHES,
});
const FORECAST = defineVerb({
	name: "forecast",
	usage:
		"usage: forecast [--json] [--act] [--db <samples.jsonl>] [--queued N] [--cost-per-item F] [--horizon-hours H] [--overage-permitted|--no-overage] [--overage-cost F] [--dedupe-hours H]",
	flags: FLAGS,
	switches: SWITCHES,
});
const VERBS: VerbSpec[] = [SAMPLE, FORECAST];

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
	console.log(
		renderRegistryHelp(
			"credit-forecast",
			"credit-forecast — W566 premium-credit headroom forecast (forecast is the default verb).",
			VERBS,
		),
	);
	process.exit(0);
}
const named = argv[0] === "sample" || argv[0] === "forecast";
const spec = named ? (argv[0] === "sample" ? SAMPLE : FORECAST) : FORECAST;
const outcome = parseVerb(spec, named ? argv.slice(1) : argv);
if (!outcome.ok) die(outcome.message || (spec.usage ?? ""));
const p: Parsed = outcome.parsed;

const runSample = (): void => {
	// --used/--limit are reqFlags — presence guaranteed at parse; the finite
	// check stays here (parse can't know "5x" isn't a credit count)
	const u = Number(p.flag("--used"));
	const l = Number(p.flag("--limit"));
	if (!Number.isFinite(u) || !Number.isFinite(l))
		die(
			"sample needs finite --used and --limit (credits, never inferred from tokens)",
		);
	const db = p.flag("--db") ?? samplesPathDefault();
	const mult = p.flag("--multipliers");
	const note = p.flag("--note");
	const sample = {
		at: Date.now(),
		used: u,
		limit: l,
		plan: p.flag("--plan") ?? "unknown",
		multipliers: mult ? parseMultipliers(mult) : {},
		source: p.flag("--source") ?? "manual",
		...(note !== null ? { note } : {}),
	};
	appendSample(db, sample);
	console.log(`sampled: ${sampleLine(sample)}`);
};
const runForecast = (): void => {
	const db = p.flag("--db") ?? samplesPathDefault();
	const policy = mergePolicy(
		DEFAULT_POLICY,
		mergePolicy(envPolicy(), policyFromArgv(argv)),
	);
	const f = forecastHeadroom(loadSamples(db), {});
	const a = assess(f, policy);
	const json = p.flag("--json") === "true";
	if (json)
		console.log(
			JSON.stringify(
				{ verdict: a.verdict, forecast: f, lines: a.lines },
				null,
				2,
			),
		);
	else for (const l of a.lines) console.log(l);
	if (p.flag("--act") === "true") {
		const line = forecastPush({
			act: true,
			samplesPath: db,
			statePath: p.flag("--state") ?? statePathDefault(),
			policy,
		});
		if (line !== null) console.log(`act: ${line}`);
	}
	process.exit(a.verdict === "OK" ? 0 : a.verdict === "WARN" ? 1 : 2);
};

const dedupeHours = (): number | undefined => {
	const h = p.flag("--dedupe-hours");
	if (h === null) return undefined;
	const n = Number(h);
	return Number.isFinite(n) ? n * 3_600_000 : undefined;
};
if (argv[0] === "sample") {
	runSample();
	// a fresh authoritative read immediately re-evaluates the push: same
	// path the dispatch loop takes, so a warning lands the same turn
	const line = forecastPush({
		act: true,
		samplesPath: p.flag("--db") ?? samplesPathDefault(),
		statePath: p.flag("--state") ?? statePathDefault(),
		policy: mergePolicy(envPolicy(), policyFromArgv(argv)),
		dedupeMs: dedupeHours(),
	});
	if (line !== null) console.log(`forecast: ${line}`);
	process.exit(0);
}
runForecast();
