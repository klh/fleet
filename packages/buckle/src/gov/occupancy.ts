// src/gov/occupancy.ts — W2618 hub admission caps: per-hub, per-user and
// per-model concurrent-admission limits enforced at the ingress seam, plus
// the occupancy report the belt board renders as per-model utilization
// cards. Totals are TREE-DERIVED (owner spec 2026-11-03): the hub-level
// total is the sum of the per-model caps (models differ wildly — some
// allow 100s of connections, others a few), so no operator-maintained
// grand total exists; an explicit `hub_total` caps overall admissions and
// becomes the gauge denominator when present.
//
// Config-over-code: the caps JSON rides the machine stack.json hub profile
// (`hubs.<label>.admission_caps`), rendered by hubctl into the compose env
// as HUB_BUCKLE_ADMISSION_CAPS → BUCKLE_ADMISSION_CAPS inside the gate
// container. Absent env = disabled (zero overhead, zero throttling — the
// W1068 opt-in doctrine). A CONFIGURED but malformed payload logs and
// stays inert (never a startup fatal — caps are throttle, not safety).
//
// Exactness: counters track admissions from the ingress acquire to the
// real settle (the wire-stamp seam — the same exactness law as the W1259
// inflight index: a still-open request NEVER leaves the active set). No
// evict-oldest, no age-based staleness; the active map is bounded by the
// caps themselves, which refuse past their ceilings.
import { z } from "zod";

export const AdmissionCapsSchema = z.object({
	/** Cap overall hub admissions; also the hub gauge denominator. */
	hub_total: z.number().int().positive().optional(),
	/** Default per-user cap for users without an explicit row. */
	user_default: z.number().int().positive().optional(),
	/** Explicit per-user (key id) caps. */
	users: z.record(z.string(), z.number().int().positive()).optional(),
	/** Per-model-group caps — the tree-derived axes. */
	models: z.record(z.string(), z.number().int().positive()).optional(),
});

export type AdmissionCaps = z.infer<typeof AdmissionCapsSchema>;

export const OCCUPANCY_ENV_KNOB = "BUCKLE_ADMISSION_CAPS";

/** Parse the env JSON. null = disabled (absent OR malformed — malformed
 *  logs loudly and stays inert; throttle config never takes the gate down). */
export function capsFromEnv(
	env: Record<string, string | undefined> = process.env,
): AdmissionCaps | null {
	const raw = env[OCCUPANCY_ENV_KNOB];
	if (raw === undefined || raw.trim() === "") return null;
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		console.error(
			`buckle: ${OCCUPANCY_ENV_KNOB} is not valid JSON — occupancy caps INERT`,
		);
		return null;
	}
	const parsed = AdmissionCapsSchema.safeParse(doc);
	if (!parsed.success) {
		console.error(
			`buckle: ${OCCUPANCY_ENV_KNOB} failed validation — occupancy caps INERT: ${z.prettifyError(parsed.error)}`,
		);
		return null;
	}
	const caps = parsed.data;
	if (
		caps.hub_total === undefined &&
		caps.user_default === undefined &&
		(caps.users === undefined || Object.keys(caps.users).length === 0) &&
		(caps.models === undefined || Object.keys(caps.models).length === 0)
	)
		return null;
	return caps;
}

/** The tree-derived hub total: the sum of the per-model caps. */
export function derivedTotal(caps: AdmissionCaps): number {
	return Object.values(caps.models ?? {}).reduce((a, b) => a + b, 0);
}

interface OccEntry {
	user: string;
	model: string;
	startMs: number;
}

interface Sample {
	ts_ms: number;
	total: number;
	by_model: Record<string, number>;
}

/** Bounded sparkline ring: one sample per SAMPLE_PERIOD_MS, SAMPLE_MAX kept
 *  (~2.4h at 30s — the belt board's progress bars need time series, not
 *  just instantaneous values, owner screenshot 2026-11-03). */
const SAMPLE_PERIOD_MS = 30_000;
const SAMPLE_MAX = 288;

// ─── process-global state (the drain.ts / inflight.ts precedent) ────────────

let caps: AdmissionCaps | null | undefined;
const active = new Map<string, OccEntry>();
/** Admitted-at timestamps for the rolling gauges; pruned on write+read. */
const admitted: number[] = [];
const samples: Sample[] = [];
let lastSampleMs = 0;

function capOf(): AdmissionCaps | null {
	if (caps === undefined) caps = capsFromEnv();
	return caps;
}

/** Test seam: recompute caps + clear the registry. */
export function resetOccupancyForTest(
	next: AdmissionCaps | null = capsFromEnv(),
): void {
	caps = next;
	active.clear();
	admitted.length = 0;
	samples.length = 0;
	lastSampleMs = 0;
}

export function occupancyEnabled(): boolean {
	return capOf() !== null;
}

function pruneAdmitted(atMs: number): void {
	const floor = atMs - 5 * 60_000;
	while (admitted.length > 0 && (admitted[0] ?? 0) < floor) admitted.shift();
}

/** Counters of currently-open admissions per user / per model. */
function countBy<K extends "user" | "model">(axis: K): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of active.values()) out[e[axis]] = (out[e[axis]] ?? 0) + 1;
	return out;
}

/** Take one admission (rid-keyed). False = a cap is full — the caller
 *  answers 429 at the ingress seam. The admission releases ONLY at the
 *  real settle (wire-stamp / proxy-stream) — releaseOccupancy(rid). */
export function acquireOccupancy(
	rid: string,
	user: string,
	model: string,
	nowMs: number = Date.now(),
): boolean {
	const c = capOf();
	if (c === null) return true;
	if (active.has(rid)) return true; // idempotent re-entry
	pruneAdmitted(nowMs);
	const perModel = c.models?.[model];
	const perUser = c.users?.[user] ?? c.user_default;
	if (perModel !== undefined) {
		let n = 0;
		for (const e of active.values()) if (e.model === model) n++;
		if (n >= perModel) return false;
	}
	if (perUser !== undefined) {
		let n = 0;
		for (const e of active.values()) if (e.user === user) n++;
		if (n >= perUser) return false;
	}
	if (c.hub_total !== undefined && active.size >= c.hub_total) return false;
	active.set(rid, { user, model, startMs: nowMs });
	admitted.push(nowMs);
	return true;
}

/** Give the admission back at the real settle. Unknown rid = no-op
 *  (denials before the acquire or already-released settles). */
export function releaseOccupancy(rid: string): void {
	active.delete(rid);
}

/** Sparkline sample: appended lazily at most once per period on read. */
function maybeSample(atMs: number): void {
	if (atMs - lastSampleMs < SAMPLE_PERIOD_MS) return;
	lastSampleMs = atMs;
	const byModel = countBy("model");
	samples.push({ ts_ms: atMs, total: active.size, by_model: byModel });
	while (samples.length > SAMPLE_MAX) samples.shift();
}

// W2781 (W1238.4 schema law): the report wire face is a named zod schema —
// one source of truth for the GET /v1/admin/occupancy body; consumers
// (belt occupancy-face) safeParse against it instead of hand-rolling
// structural checks that let nested drift render garbage.
const BoundedNumSchema = z.number().int().nonnegative().nullable();

export const OccupancyUserRowSchema = z.object({
	user: z.string(),
	current: z.number().int().nonnegative(),
	max: BoundedNumSchema,
});

export const OccupancyModelRowSchema = z.object({
	model: z.string(),
	current: z.number().int().nonnegative(),
	max: BoundedNumSchema,
	pct: BoundedNumSchema,
	users: z.array(OccupancyUserRowSchema),
});

export type OccupancyUserRow = z.infer<typeof OccupancyUserRowSchema>;
export type OccupancyModelRow = z.infer<typeof OccupancyModelRowSchema>;

/** The GET /v1/admin/occupancy wire body — parsed, not assumed. */
export const OccupancyReportSchema = z.object({
	hub: z.string(),
	enabled: z.boolean(),
	generated_ms: z.number(),
	caps: AdmissionCapsSchema.nullable(),
	derived_total: z.number(),
	totals: z.object({
		current: z.number().int().nonnegative(),
		max: z.number().int().nonnegative(),
		basis: z.enum(["hub_total", "derived"]),
	}),
	models: z.array(OccupancyModelRowSchema),
	users: z.array(OccupancyUserRowSchema),
	gauges: z.object({
		admitted_1m: z.number().int().nonnegative(),
		admitted_5m: z.number().int().nonnegative(),
		active: z.number().int().nonnegative(),
	}),
	samples: z.array(
		z.object({
			ts_ms: z.number(),
			total: z.number().int().nonnegative(),
			by_model: z.record(z.string(), z.number()),
		}),
	),
});

export interface OccupancyReport {
	hub: string;
	enabled: boolean;
	generated_ms: number;
	caps: AdmissionCaps | null;
	derived_total: number;
	totals: { current: number; max: number; basis: "hub_total" | "derived" };
	models: OccupancyModelRow[];
	users: OccupancyUserRow[];
	gauges: { admitted_1m: number; admitted_5m: number; active: number };
	samples: Sample[];
}

/** The occupancy report GET /v1/admin/occupancy serves: per-model cards
 *  (current vs tree-derived max + per-user rows underneath), the hub-level
 *  total gauge, rolling 1m/5m admission gauges and the sparkline ring. */
export function occupancySnapshot(
	hubId: string,
	atMs = Date.now(),
): OccupancyReport {
	const c = capOf();
	pruneAdmitted(atMs);
	maybeSample(atMs);
	const derived = c === null ? 0 : derivedTotal(c);
	const basis = c?.hub_total !== undefined ? "hub_total" : "derived";
	const byModel = countBy("model");
	const byUser = countBy("user");
	const capForModel = (m: string): number | null => c?.models?.[m] ?? null;
	// W2781: idle configured models must still render a card — the row set
	// is the UNION of active models and every configured per-model cap, so a
	// capped model at 0 current shows its 0/N card instead of vanishing.
	const models: OccupancyModelRow[] = [
		...new Set([...Object.keys(byModel), ...Object.keys(c?.models ?? {})]),
	]
		.sort()
		.map((m) => {
			const current = byModel[m] ?? 0;
			const max = capForModel(m);
			return {
				model: m,
				current,
				max,
				pct: max === null ? null : Math.round((current / max) * 100),
				users: [],
			};
		});
	// per-user rows ride their model card + a flat list
	const userRowsFor = (m: string): OccupancyUserRow[] => {
		const counts: Record<string, number> = {};
		for (const e of active.values())
			if (e.model === m) counts[e.user] = (counts[e.user] ?? 0) + 1;
		return Object.keys(counts)
			.sort()
			.map((u) => ({
				user: u,
				current: counts[u] ?? 0,
				max: c?.users?.[u] ?? c?.user_default ?? null,
			}));
	};
	for (const row of models) row.users = userRowsFor(row.model);
	const users: OccupancyUserRow[] = Object.keys(byUser)
		.sort()
		.map((u) => ({
			user: u,
			current: byUser[u] ?? 0,
			max: c?.users?.[u] ?? c?.user_default ?? null,
		}));
	const totalMax = basis === "hub_total" ? (c?.hub_total ?? 0) : derived;
	return {
		hub: hubId,
		enabled: c !== null,
		generated_ms: atMs,
		caps: c,
		derived_total: derived,
		totals: { current: active.size, max: totalMax, basis },
		models,
		users,
		gauges: {
			admitted_1m: admitted.filter((t) => t >= atMs - 60_000).length,
			admitted_5m: admitted.length,
			active: active.size,
		},
		samples: [...samples],
	};
}
