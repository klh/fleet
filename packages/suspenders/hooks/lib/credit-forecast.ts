// hooks/lib/credit-forecast.ts — W566 premium-credit headroom forecast.
// The fleet pushes work through copilot CLI lanes on metered premium
// requests (W223.2 meters the SPEND; this module forecasts the HEADROOM).
// Owner report 2026-10-07: 29986/50000 premium credits (59.9%), business
// plan (overage permitted), no reset date pending — and outages are not
// quota. The plan counter is authoritative; tokens/requests are never
// inferred to be credits, and no reset ETA is ever invented (the sample
// shape carries no reset field at all).
//
// Design (quota-window state-file + metrics-alert precedents):
//   sample   an authoritative read of the plan counter — used/limit/plan +
//            model multipliers — appended to a bounded JSONL history
//            (~/.cache/claude-governor/credit-samples.jsonl).
//   forecast windowed deltas → burn/h with an uncertainty band (min/max
//            usable window rate), remaining credits, runway vs horizon.
//   budget   queued work × cost/item (explicit config, never inferred from
//            tokens) vs remaining; overage policy (permitted? unit cost?).
//   alert    two arms — projected push need > remaining, or pessimistic
//            runway < horizon — deduped via a state file (same key re-alerts
//            only after the dedupe window; key change = escalation or
//            recovery, both surface).
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

// /Users/<name> paths never leave through a broadcast (quota-sweep parity)
const scrub = (s: string): string => s.replace(/\/Users\/[^/\s'"]+/g, "~");

export const samplesPathDefault = (): string =>
	process.env.CREDIT_FORECAST_SAMPLES ??
	`${homedir()}/.cache/claude-governor/credit-samples.jsonl`;

export const statePathDefault = (): string =>
	process.env.CREDIT_FORECAST_STATE ??
	`${homedir()}/.cache/claude-governor/credit-forecast-state.json`;
export type CreditSample = {
	at: number; // ms epoch of the authoritative read
	used: number; // premium credits consumed (plan counter)
	limit: number; // plan allowance
	plan: string; // e.g. "business"
	multipliers: Record<string, number>; // model → premium-request multiplier
	source: string; // where the read came from, e.g. "dashboard"
	note?: string;
};

// "opus=15,sonnet=1" → { opus: 15, sonnet: 1 }; junk pairs drop honestly
export const parseMultipliers = (spec: string): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const pair of spec.split(",")) {
		const m = /^([A-Za-z0-9._-]+)=(-?[\d.]+)$/.exec(pair.trim());
		if (!m) continue;
		const v = Number(m[2]);
		if (Number.isFinite(v)) out[m[1]] = v;
	}
	return out;
};
const requireFinite = (
	used: unknown,
	limit: unknown,
): {
	used: number;
	limit: number;
} => {
	const u = typeof used === "number" ? used : Number(used);
	const l = typeof limit === "number" ? limit : Number(limit);
	if (!Number.isFinite(u) || !Number.isFinite(l))
		throw new Error(
			"sample needs finite used+limit (never inferred from tokens)",
		);
	return { used: u, limit: l };
};

export const sampleLine = (s: CreditSample): string => JSON.stringify(s);

export const appendSample = (path: string, s: CreditSample): void => {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${sampleLine(s)}\n`);
};
// parse, sort by at, bounded tail keep; malformed lines drop honestly —
// a corrupt line never kills the forecast
export const loadSamples = (
	path: string,
	opts: { keep?: number; now?: number } = {},
): CreditSample[] => {
	if (!existsSync(path)) return [];
	const keep = opts.keep ?? 2000;
	const text = readFileSync(path, "utf8");
	const lines = text.length === 0 ? [] : text.trimEnd().split("\n");
	const out: CreditSample[] = [];
	for (const line of lines.slice(-keep)) {
		try {
			const p = JSON.parse(line) as Record<string, unknown>;
			if (typeof p.at !== "number" || !Number.isFinite(p.at)) continue;
			const { used, limit } = requireFinite(p.used, p.limit);
			out.push({
				at: p.at,
				used,
				limit,
				plan: typeof p.plan === "string" ? p.plan : "unknown",
				multipliers:
					p.multipliers && typeof p.multipliers === "object"
						? (p.multipliers as Record<string, number>)
						: {},
				source: typeof p.source === "string" ? p.source : "unrecorded",
				...(typeof p.note === "string" ? { note: p.note } : {}),
			});
		} catch {
			// not JSON / bad numbers — honest drop
		}
	}
	return out.sort((a, b) => a.at - b.at);
};
export type WindowRate = {
	label: string;
	ms: number;
	delta: number | null; // credits across the window's covered span
	spanMs: number | null; // actual span the delta covers
	perHour: number | null; // usable when spanMs ≥ 5 min
};

const MIN_SPAN_MS = 5 * 60_000; // less context than this never extrapolates

export const DEFAULT_WINDOWS: Array<{ label: string; ms: number }> = [
	{ label: "1h", ms: 3_600_000 },
	{ label: "24h", ms: 86_400_000 },
	{ label: "7d", ms: 604_800_000 },
];

// used(latest) − used(anchor at-or-before now−ms); the anchor falls back to
// the first sample so a short history still yields one honest long window
export const windowedDeltas = (
	samples: CreditSample[],
	now: number,
	windows: Array<{ label: string; ms: number }> = DEFAULT_WINDOWS,
): WindowRate[] => {
	const latest = samples[samples.length - 1];
	if (!latest) return [];
	return windows.map((w) => {
		let anchor: CreditSample | undefined;
		for (const s of samples)
			if (s.at <= now - w.ms) anchor = s;
			else break;
		const a = anchor ?? samples[0];
		if (!a)
			return {
				label: w.label,
				ms: w.ms,
				delta: null,
				spanMs: null,
				perHour: null,
			};
		const spanMs = latest.at - a.at;
		const delta = latest.used - a.used;
		return {
			label: w.label,
			ms: w.ms,
			delta,
			spanMs,
			perHour:
				spanMs >= MIN_SPAN_MS && spanMs > 0
					? (delta / spanMs) * 3_600_000
					: null,
		};
	});
};
export type Forecast = {
	ok: boolean; // false = UNKNOWN (why says which)
	why?: string;
	at: number | null; // newest sample's read time
	used: number | null;
	limit: number | null;
	remaining: number | null;
	pctUsed: number | null;
	plan: string | null;
	multipliers: Record<string, number>;
	source: string | null;
	windows: WindowRate[];
	burnPerHour: number | null; // longest usable window = most context
	uncertainty: { low: number | null; high: number | null }; // usable-rate spread
	runwayHours: number | null; // remaining / point burn; null = no/unknown burn
	notes: string[];
};

const emptyForecast = (why: string): Forecast => ({
	ok: false,
	why,
	at: null,
	used: null,
	limit: null,
	remaining: null,
	pctUsed: null,
	plan: null,
	multipliers: {},
	source: null,
	windows: [],
	burnPerHour: null,
	uncertainty: { low: null, high: null },
	runwayHours: null,
	notes: ["no premium-credit samples — log one authoritative read"],
});
export const forecastHeadroom = (
	samples: CreditSample[],
	opts: { now?: number } = {},
): Forecast => {
	const now = opts.now ?? Date.now();
	const latest = samples[samples.length - 1];
	if (!latest) return emptyForecast("no samples");
	const windows = windowedDeltas(samples, now);
	const rates = windows
		.map((w) => w.perHour)
		.filter((r): r is number => r !== null);
	// longest usable window wins (windows are ordered shortest→longest);
	// a negative rate (top-up/correction) is never extrapolated — runway
	// stays null and a note says so
	const burnPerHour =
		rates.length > 0 ? (rates[rates.length - 1] ?? null) : null;
	const uncertainty = {
		low: rates.length > 0 ? Math.min(...rates) : null,
		high: rates.length > 0 ? Math.max(...rates) : null,
	};
	const remaining = Math.max(0, latest.limit - latest.used);
	const runwayHours =
		burnPerHour !== null && burnPerHour > 0 ? remaining / burnPerHour : null;
	const notes: string[] = [];
	if (burnPerHour !== null && burnPerHour < 0)
		notes.push(
			"counter decreased — top-up or correction; burn not extrapolated",
		);
	if (latest.at < now - 48 * 3_600_000)
		notes.push(
			`newest sample is ${Math.round((now - latest.at) / 3_600_000)}h old`,
		);
	return {
		ok: true,
		at: latest.at,
		used: latest.used,
		limit: latest.limit,
		remaining,
		pctUsed: latest.limit > 0 ? (latest.used / latest.limit) * 100 : null,
		plan: latest.plan,
		multipliers: latest.multipliers,
		source: latest.source,
		windows,
		burnPerHour,
		uncertainty,
		runwayHours,
		notes,
	};
};
export type PushPolicy = {
	queued: number | null; // READY items the push would fan out
	costPerItem: number | null; // configured avg premium credits per item
	horizonHours: number; // push-planning horizon
	overagePermitted: boolean;
	overageUnitCost: number | null;
};

export type Assessment = {
	verdict: "OK" | "WARN" | "UNKNOWN";
	arms: string[]; // fired alert arms: "need" | "runway"
	lines: string[];
	projectedNeed: number | null;
	overageUnits: number | null;
	overageCost: number | null;
};

const fmt = (n: number, digits = 1): string =>
	Number.isFinite(n) ? n.toFixed(digits) : String(n);

// alert key = severity + fired arms, so escalation (a new arm firing) or
// recovery (all clear) re-alerts inside the dedupe window
export const alertKeyOf = (a: Assessment): string =>
	a.verdict === "WARN" ? `warn:${[...a.arms].sort().join("+")}` : a.verdict;

export const assess = (f: Forecast, policy: PushPolicy): Assessment => {
	if (!f.ok)
		return {
			verdict: "UNKNOWN",
			arms: [],
			lines: [`credit forecast: UNKNOWN — ${f.why ?? "no data"}`],
			projectedNeed: null,
			overageUnits: null,
			overageCost: null,
		};
	return assessOk(f, policy);
};
const assessOk = (f: Forecast, policy: PushPolicy): Assessment => {
	const lines: string[] = [];
	const at = new Date(f.at ?? 0).toISOString();
	lines.push(
		`premium credits (${f.plan ?? "unknown plan"}, ${f.source ?? "?"}, read ${at}): ${f.used}/${f.limit} used (${fmt(f.pctUsed ?? 0)}%) — remaining ${f.remaining}`,
	);
	const arms: string[] = [];
	let projectedNeed: number | null = null;
	let overageUnits: number | null = null;
	let overageCost: number | null = null;
	if (
		policy.queued !== null &&
		policy.costPerItem !== null &&
		f.remaining !== null
	) {
		projectedNeed = policy.queued * policy.costPerItem;
		lines.push(
			`push budget: ${policy.queued} queued × ${fmt(policy.costPerItem)} credits/item ≈ ${fmt(projectedNeed, 0)} need vs ${f.remaining} remaining`,
		);
		if (projectedNeed > f.remaining) {
			arms.push("need");
			overageUnits = Math.ceil(projectedNeed - f.remaining);
			overageCost =
				policy.overagePermitted && policy.overageUnitCost !== null
					? overageUnits * policy.overageUnitCost
					: null;
			lines.push(
				`ALERT need: projected push need ${fmt(projectedNeed, 0)} > remaining ${f.remaining}` +
					(policy.overagePermitted
						? ` — overage ${overageUnits} units${policy.overageUnitCost !== null ? ` ≈ $${fmt(overageCost ?? 0, 2)}` : " (no unit cost configured)"}`
						: ` — overage NOT permitted by policy; defer work-push`),
			);
		}
	} else {
		lines.push(
			"push budget: UNKNOWN — queued count or cost/item not configured (never inferred from tokens)",
		);
	}
	assessRunway(f, policy, lines, arms);
	for (const n of f.notes) lines.push(`note: ${n}`);
	return {
		verdict: arms.length > 0 ? "WARN" : "OK",
		arms,
		lines,
		projectedNeed,
		overageUnits,
		overageCost,
	};
};
// runway arm: pessimistic (high-band) burn drains remaining before the
// horizon; the point runway is context on the same line
const assessRunway = (
	f: Forecast,
	policy: PushPolicy,
	lines: string[],
	arms: string[],
): void => {
	if (f.remaining === null) return;
	const pess = f.uncertainty.high;
	const pessRunway = pess !== null && pess > 0 ? f.remaining / pess : null;
	const pointRunway =
		f.burnPerHour !== null && f.burnPerHour > 0
			? f.remaining / f.burnPerHour
			: null;
	const runwayTxt =
		pointRunway !== null
			? `~${fmt(pointRunway, 0)}h${pessRunway !== null ? ` (pessimistic ${fmt(pessRunway, 0)}h)` : ""}`
			: "unknown";
	const band =
		f.uncertainty.low !== null
			? ` (band ${fmt(f.uncertainty.low, 1)}..${fmt(f.uncertainty.high ?? 0, 1)}/h)`
			: "";
	lines.push(
		`burn ${f.burnPerHour !== null ? `${fmt(f.burnPerHour, 1)}/h` : "unknown"}${band} — runway ${runwayTxt} vs ${policy.horizonHours}h horizon`,
	);
	if (pessRunway !== null && pessRunway < policy.horizonHours) {
		arms.push("runway");
		lines.push(
			`ALERT runway: burn trend drains remaining in ${fmt(pessRunway, 0)}h < ${policy.horizonHours}h horizon — defer non-critical push`,
		);
	}
};
export type AlertState = { key: string; at: number } | null;

// first-ever pass: alert on a non-OK key only (a fresh OK never shouts);
// key change = escalation or recovery; same key re-alerts after dedupeMs
export const shouldAlert = (
	state: AlertState,
	key: string,
	now: number,
	dedupeMs: number,
): boolean => {
	if (state === null) return key !== "OK" && key !== "UNKNOWN";
	if (state.key !== key) return true;
	return now - state.at >= dedupeMs;
};

export type AlertDeps = {
	samplesPath?: string;
	statePath?: string;
	now?: number;
	act?: boolean; // false = report-only
	policy?: Partial<PushPolicy>;
	dedupeMs?: number;
	emit?: (kind: string, note: string) => void;
	broadcast?: (note: string) => void;
	factSet?: (key: string, text: string) => void;
	stateRead?: () => AlertState;
	stateWrite?: (s: { key: string; at: number }) => void;
};

const numEnv = (v: string | undefined): number | null => {
	if (v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

// machine-config channel: CREDIT_FORECAST_* env (queue count, cost/item,
// horizon, overage policy) — flags in the CLI override these
export const envPolicy = (): Partial<PushPolicy> => {
	const p: Partial<PushPolicy> = {};
	const queued = numEnv(process.env.CREDIT_FORECAST_QUEUED);
	if (queued !== null) p.queued = queued;
	const cost = numEnv(process.env.CREDIT_FORECAST_COST_PER_ITEM);
	if (cost !== null) p.costPerItem = cost;
	const horizon = numEnv(process.env.CREDIT_FORECAST_HORIZON_H);
	if (horizon !== null) p.horizonHours = horizon;
	const overage = process.env.CREDIT_FORECAST_OVERAGE;
	if (overage !== undefined && overage !== "")
		p.overagePermitted = /^(1|true|yes)$/i.test(overage);
	const oc = numEnv(process.env.CREDIT_FORECAST_OVERAGE_COST);
	if (oc !== null) p.overageUnitCost = oc;
	return p;
};
export const policyFromArgv = (argv: string[]): Partial<PushPolicy> => {
	const val = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const p: Partial<PushPolicy> = {};
	const numFlag = (name: string): number | null => numEnv(val(name));
	const queued = numFlag("--queued");
	if (queued !== null) p.queued = queued;
	const cost = numFlag("--cost-per-item");
	if (cost !== null) p.costPerItem = cost;
	const horizon = numFlag("--horizon-hours");
	if (horizon !== null) p.horizonHours = horizon;
	if (argv.includes("--overage-permitted")) p.overagePermitted = true;
	if (argv.includes("--no-overage")) p.overagePermitted = false;
	const oc = numFlag("--overage-cost");
	if (oc !== null) p.overageUnitCost = oc;
	return p;
};

export const DEFAULT_POLICY: PushPolicy = {
	queued: null,
	costPerItem: null,
	horizonHours: 48,
	overagePermitted: false,
	overageUnitCost: null,
};

export const mergePolicy = (
	base: PushPolicy,
	over: Partial<PushPolicy>,
): PushPolicy => ({ ...base, ...over });
// ---- default action impls (bus + state file + coord CLI; tests inject) ----

const readStateFile = (path: string): AlertState => {
	try {
		if (!existsSync(path)) return null;
		const p = JSON.parse(readFileSync(path, "utf8")) as {
			key?: string;
			at?: number;
		};
		if (typeof p.key !== "string" || typeof p.at !== "number") return null;
		return { key: p.key, at: p.at };
	} catch {
		return null;
	}
};

const writeStateFile = (path: string, s: { key: string; at: number }): void => {
	mkdirSync(dirname(path), { recursive: true });
	// atomic small-line write (metrics-alert parity)
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(s));
	renameSync(tmp, path);
};

const defaultEmit = (kind: string, note: string): void => {
	try {
		// quota-sweep parity: bus import deferred so report paths stay cheap
		const { emitEvent } = require("../coord/bus.ts") as {
			emitEvent: (o: { kind: string; note: string; source: string }) => void;
		};
		emitEvent({ kind, note, source: "credit-forecast" });
	} catch {
		// bus down — broadcast + fact still try
	}
};

const defaultBroadcast = (note: string): void => {
	try {
		const { broadcastNote } = require("../coord/bus.ts") as {
			broadcastNote: (n: string, source: string) => unknown;
		};
		broadcastNote(note, "credit-forecast");
	} catch {
		// best-effort
	}
};
/** One-call seam for dispatch-next: load samples → forecast → assess →
 *  dedupe-gated alert. Returns the one-line summary or null (nothing new
 *  to say). Alerts only under `act`; state/files injected in tests. */
export const forecastPush = (opts: AlertDeps = {}): string | null => {
	const now = opts.now ?? Date.now();
	const samplesPath = opts.samplesPath ?? samplesPathDefault();
	const statePath = opts.statePath ?? statePathDefault();
	const f = forecastHeadroom(loadSamples(samplesPath), { now });
	const policy = mergePolicy(DEFAULT_POLICY, {
		...envPolicy(),
		...(opts.policy ?? {}),
	});
	const a = assess(f, policy);
	const key = alertKeyOf(a);
	const state = opts.stateRead ? opts.stateRead() : readStateFile(statePath);
	const dedupeMs = opts.dedupeMs ?? 24 * 3_600_000;
	if (!opts.act)
		return a.verdict === "OK" ? null : `${a.verdict}: ${a.lines.join(" · ")}`;
	if (!shouldAlert(state, key, now, dedupeMs)) return null;
	const write = opts.stateWrite ?? ((s) => writeStateFile(statePath, s));
	write({ key, at: now });
	if (a.verdict === "WARN") {
		const note = `[credit-forecast] ${scrub(a.lines.join(" — "))}`;
		(opts.emit ?? defaultEmit)("credit.headroom.warn", note);
		(opts.broadcast ?? defaultBroadcast)(note);
		(opts.factSet ?? defaultFactSet)(
			"copilot.credits.headroom",
			JSON.stringify({
				verdict: a.verdict,
				arms: a.arms,
				used: f.used,
				limit: f.limit,
				remaining: f.remaining,
				pctUsed: f.pctUsed,
				burnPerHour: f.burnPerHour,
				runwayHours: f.runwayHours,
				projectedNeed: a.projectedNeed,
				overageUnits: a.overageUnits,
				overageCost: a.overageCost,
				at: f.at,
			}),
		);
	}
	return `${a.verdict}: ${a.lines.join(" · ")}`;
};
const defaultFactSet = (key: string, text: string): void => {
	try {
		const bin = new URL("../../bin/coord.ts", import.meta.url).pathname;
		Bun.spawnSync(
			[
				process.execPath,
				bin,
				"fact",
				"set",
				key,
				"--text",
				text,
				"--source",
				"credit-forecast",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
	} catch {
		// fact face down — alert already went out via emit/broadcast
	}
};
