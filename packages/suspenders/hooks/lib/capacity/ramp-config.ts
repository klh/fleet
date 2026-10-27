// hooks/lib/capacity/ramp-config.ts — W1713 flag → RampConfig, with the
// harness's own hard safety bounds. The bounds cap a single operator run
// (no unlimited stress); they are NOT provider/posture ceilings and say
// nothing about how many lanes the stack should admit.
import type { ToolMode } from "./ramp-classify.ts";
import type { RampConfig } from "./ramp-run.ts";
import type { RampRoute, RampWire } from "./ramp-types.ts";

export const HARD = {
	concurrency: 32,
	requests: 1_000,
	minutes: 30,
	holdS: 300,
	maxOut: 256,
	prefixTokens: 20_000,
} as const;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });
const pass = <T>(value: T): Parsed<T> => ({ ok: true, value });

const ROUTE_RE =
	/^(?:([a-z0-9][a-z0-9._-]*)=)?([^\s@=]+)@(messages|responses)$/;

/** `[name=]model@wire` — model is the gateway group id lanes send. */
export function parseRoute(spec: string): Parsed<RampRoute> {
	const m = ROUTE_RE.exec(spec);
	if (m === null)
		return fail(`bad --route '${spec}' (want [name=]model@messages|responses)`);
	const model = m[2] ?? "";
	return pass({
		name: m[1] ?? model,
		model,
		wire: (m[3] ?? "messages") as RampWire,
	});
}

export function parseSteps(raw: string): Parsed<number[]> {
	const steps = raw.split(",").map((s) => Number(s.trim()));
	if (steps.some((n) => !Number.isInteger(n) || n < 1 || n > HARD.concurrency))
		return fail(`--steps must be integers 1..${String(HARD.concurrency)}`);
	if (steps.some((n, i) => i > 0 && n <= (steps[i - 1] ?? 0)))
		return fail("--steps must ascend strictly");
	return pass(steps);
}

type Num = { def: number; min: number; max: number };

function num(raw: string | null, label: string, b: Num): Parsed<number> {
	if (raw === null) return pass(b.def);
	const v = Number(raw);
	if (!Number.isFinite(v) || v < b.min || v > b.max)
		return fail(`${label} must be ${String(b.min)}..${String(b.max)}`);
	return pass(v);
}

const NUMS = {
	"--hold-s": { def: 20, min: 0.05, max: HARD.holdS },
	"--gap-ms": { def: 250, min: 0, max: 60_000 },
	"--max-requests": { def: 120, min: 1, max: HARD.requests },
	"--max-minutes": { def: 5, min: 0.05, max: HARD.minutes },
	"--max-p95-ms": { def: 30_000, min: 1, max: 600_000 },
	"--max-err-pct": { def: 20, min: 0, max: 100 },
	"--min-samples": { def: 3, min: 1, max: 1_000 },
	"--max-out": { def: 64, min: 1, max: HARD.maxOut },
	"--prefix-tokens": { def: 0, min: 0, max: HARD.prefixTokens },
	"--request-timeout-ms": { def: 60_000, min: 100, max: 300_000 },
	"--sample-ms": { def: 1_000, min: 20, max: 60_000 },
	"--drain-ms": { def: 15_000, min: 0, max: 120_000 },
} as const satisfies Record<string, Num>;

export interface FlagReader {
	flag: (name: string) => string | null;
	all: (name: string) => string[];
}

export function buildConfig(p: FlagReader, runId: string): Parsed<RampConfig> {
	const routes: RampRoute[] = [];
	for (const spec of p.all("--route")) {
		const r = parseRoute(spec);
		if (!r.ok) return r;
		routes.push(r.value);
	}
	if (routes.length === 0) return fail("at least one --route is required");
	if (new Set(routes.map((r) => r.name)).size !== routes.length)
		return fail("--route names must be unique");
	const steps = parseSteps(p.flag("--steps") ?? "1,2,4");
	if (!steps.ok) return steps;
	const toolMode = p.flag("--tool-mode") ?? "force";
	if (toolMode !== "force" && toolMode !== "auto" && toolMode !== "none")
		return fail("--tool-mode must be force|auto|none");
	const v = {} as Record<keyof typeof NUMS, number>;
	for (const [flag, bound] of Object.entries(NUMS)) {
		const n = num(p.flag(flag), flag, bound);
		if (!n.ok) return n;
		v[flag as keyof typeof NUMS] = n.value;
	}
	return pass({
		runId,
		lanePrefix: `autow1713-cap${runId}`,
		routes,
		steps: steps.value,
		holdS: v["--hold-s"],
		gapMs: v["--gap-ms"],
		maxRequests: v["--max-requests"],
		maxMinutes: v["--max-minutes"],
		rules: {
			maxP95Ms: v["--max-p95-ms"],
			maxErrPct: v["--max-err-pct"],
			minSamples: v["--min-samples"],
		},
		toolMode: toolMode as ToolMode,
		maxOut: v["--max-out"],
		prefixTokens: v["--prefix-tokens"],
		requestTimeoutMs: v["--request-timeout-ms"],
		sampleMs: v["--sample-ms"],
		drainMs: v["--drain-ms"],
	});
}
