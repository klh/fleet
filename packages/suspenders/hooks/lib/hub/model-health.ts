// hooks/lib/hub/model-health.ts — W2194: the hub model-health sweep + the
// pin-layer fallback it feeds. Root cause 2026-10-27: glm-5.3-flash hard-down
// 500s for hours while 818 lane model pins kept firing reviews into the dead
// leg — no health signal existed to re-pin. Every configured hub (stack.json
// profiles) + the local Mac spoke probes each catalog group through ITS OWN
// buckle front (tiny max_tokens call), banks model.health.<core> facts
// {status, latencyMs, servedModel, ts, hub, wireId}, and the pickers —
// dispatch (execPick's model pins) and the review scheduler — re-pin to the
// freshest healthy group when the pinned group is DOWN. A re-pin is loud and
// recorded (repinned_from), never a silent alias — the W1302.6 wire audit
// stays: it grades the SERVED wire model against whatever the leg REQUESTED,
// so a fallback that kept the old name while riding another model would still
// fail the receipt.
import { z } from "zod";
import { modelCore, wireModelMatch } from "../gates/wire-model-check.ts";
import { adminKey, hubCredential } from "../lanes/lane-auth.ts";
import { BUCKLE_SPOKE_PORT, loopbackUrl } from "../loopback.ts";
import { darkHubNow, loadStack } from "../stack-config.ts";
import { hubBuckleUrl } from "./hub-endpoint.ts";

/** Fact keys ride the dots-to-dashes model CLASS CORE (modelCore) — the
 *  comparable vocabulary every hub's catalog ids normalize into, so
 *  `glm-5.3-flash` and a hub's `zai-glm-5.3-flash` merge into one group row.
 *  Display/pin vocabulary stays the serving hub's wire id (value.wireId). */
export const MODEL_HEALTH_PREFIX = "model.health.";
/** Stale > 15min = unknown, not healthy (the mission's expiry law). */
export const MODEL_HEALTH_STALE_MS = 15 * 60_000;
/** The maintenance-registry cadence (~10min). */
export const MODEL_HEALTH_SWEEP_S = 600;
export const MODEL_HEALTH_PROBE_TIMEOUT_MS = 15_000;
/** Small stagger between a hub's group probes — never a burst. */
export const MODEL_HEALTH_STAGGER_MS = 150;

export type ModelHealthStatus = "up" | "down" | "unknown";

/** The minimal store face the health layer needs — GovernorStore and a raw
 *  bun:sqlite Database both satisfy it structurally (the board/report faces
 *  hold a Database, the sweep holds the GovernorStore). */
export interface ModelHealthStore {
	query(sql: string): { all(): unknown[] };
	run(sql: string, ...params: unknown[]): unknown;
}

/** The banked fact value. `wireId` is the catalog id the probe rode — the
 *  re-pin target keeps the serving hub's own spelling. */
export const ModelHealthFact = z.object({
	status: z.enum(["up", "down", "unknown"]),
	latencyMs: z.number().nullable(),
	servedModel: z.string().nullable(),
	ts: z.number(),
	hub: z.string(),
	wireId: z.string().nullable().default(null),
	reason: z.string().nullable().default(null),
});
export type ModelHealthFact = z.infer<typeof ModelHealthFact>;

/** One probe verdict (pre-merge). Pure mapping — tests feed statuses. */
export const probeVerdictOf = (
	httpStatus: number | null,
	body: { model?: unknown } | null,
	errText: string | null,
): {
	status: ModelHealthStatus;
	servedModel: string | null;
	reason: string | null;
} => {
	if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
		const served =
			typeof body?.model === "string" && body.model.trim() !== ""
				? body.model.trim()
				: null;
		return { status: "up", servedModel: served, reason: null };
	}
	// Probe-credential / probe-path problems are OUR evidence gap, never
	// group-down evidence — banking down here would poison the picker.
	if (httpStatus === 401 || httpStatus === 403)
		return {
			status: "unknown",
			servedModel: null,
			reason: `auth ${httpStatus}`,
		};
	if (httpStatus === 404)
		return {
			status: "unknown",
			servedModel: null,
			reason: "probe path absent",
		};
	return {
		status: "down",
		servedModel: null,
		reason:
			errText ?? (httpStatus !== null ? `http ${httpStatus}` : "probe failed"),
	};
};

const CatalogBody = z.object({
	data: z.array(z.object({ id: z.string() })).default([]),
});

/** One hub's configured model groups: its buckle front's /v1/models catalog
 *  (auth-gated by the hub credential; null = unavailable — the hub keeps its
 *  previous facts and they age out; unknown is never invented). */
export const fetchHubCatalog = async (
	url: string,
	key: string | null,
	timeoutMs = MODEL_HEALTH_PROBE_TIMEOUT_MS,
): Promise<string[] | null> => {
	try {
		const r = await fetch(`${url.replace(/\/$/, "")}/v1/models`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: key ? { authorization: `Bearer ${key}` } : {},
		});
		if (!r.ok) return null;
		const parsed = CatalogBody.safeParse(await r.json());
		if (!parsed.success) return null;
		return parsed.data.data.map((d) => d.id).filter((id) => id !== "");
	} catch {
		return null;
	}
};

const ProbeBody = z.object({ model: z.string().optional() }).passthrough();

/** One tiny completion probe through the hub's own buckle (2xx up; auth/404
 *  unknown; else down). One bounded fetch — never a burst, never a pile. */
export const probeModelGroup = async (o: {
	url: string;
	key: string | null;
	group: string;
	timeoutMs?: number;
}): Promise<ProbeResult> => {
	const t0 = Date.now();
	try {
		const r = await fetch(`${o.url.replace(/\/$/, "")}/v1/messages`, {
			method: "POST",
			signal: AbortSignal.timeout(o.timeoutMs ?? MODEL_HEALTH_PROBE_TIMEOUT_MS),
			headers: {
				"content-type": "application/json",
				...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
			},
			body: JSON.stringify({
				model: o.group,
				max_tokens: 1,
				messages: [{ role: "user", content: "ping" }],
			}),
		});
		const parsed = ProbeBody.safeParse(await r.json().catch(() => null));
		return {
			latencyMs: Date.now() - t0,
			...probeVerdictOf(r.status, parsed.success ? parsed.data : null, null),
		};
	} catch (e) {
		return {
			latencyMs: Date.now() - t0,
			...probeVerdictOf(null, null, e instanceof Error ? e.message : String(e)),
		};
	}
};

export interface HealthHub {
	label: string;
	url: string;
	key: string | null;
}

/** The sweep's fan-out targets: every stack.json hub profile (dark-window
 *  hubs excluded — W483: a dark hub is EXPECTED down, probing it would bank
 *  spurious DOWN rows overnight) + the local Mac spoke. */
export const resolveHealthHubs = (
	env: NodeJS.ProcessEnv = process.env,
): HealthHub[] => {
	const out: HealthHub[] = [];
	const spokeKey = adminKey(env);
	if (spokeKey)
		out.push({
			label: "spoke",
			url: loopbackUrl(BUCKLE_SPOKE_PORT),
			key: spokeKey,
		});
	for (const [label, prof] of Object.entries(loadStack().hubs)) {
		const url = hubBuckleUrl(prof);
		if (!url || darkHubNow(label)) continue;
		out.push({ label, url, key: hubCredential(label, env) });
	}
	return out;
};

/** The fact key for one catalog id — the class core (dots→dashes). */
export const healthKeyOf = (wireId: string): string =>
	`${MODEL_HEALTH_PREFIX}${modelCore(wireId)}`;

const RANK: Record<ModelHealthStatus, number> = { up: 0, down: 1, unknown: 2 };

/** One sweep run's probe rows → banked values keyed by class core: rows fold
 *  into one group when wireModelMatch calls them the same class (the dash-
 *  extension law — `zai-glm-5.3-flash` serves `glm-5.3-flash`); any up beats
 *  down/unknown (a group up on ANY serving hub is usable); among equals the
 *  lowest latency wins; the winning row's hub + wire id ride the value so a
 *  re-pin keeps the serving hub's own spelling, and the group key keeps the
 *  SHORTEST core spelling seen (the class base). */
export const mergedGroupValues = (
	rows: (ModelHealthFact & { wireId: string })[],
): Map<string, ModelHealthFact> => {
	const groups: {
		base: string;
		rows: (ModelHealthFact & { wireId: string })[];
	}[] = [];
	for (const r of rows) {
		const hit = groups.find(
			(g) => wireModelMatch(g.base, r.wireId) === "match",
		);
		if (hit) hit.rows.push(r);
		else groups.push({ base: r.wireId, rows: [r] });
	}
	const out = new Map<string, ModelHealthFact>();
	for (const g of groups) {
		for (const r of g.rows)
			if (modelCore(r.wireId).length < modelCore(g.base).length)
				g.base = r.wireId;
		const win = [...g.rows].sort(
			(a, b) =>
				RANK[a.status] - RANK[b.status] ||
				(a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) ||
				b.ts - a.ts,
		)[0];
		out.set(modelCore(g.base), { ...win });
	}
	return out;
};

export interface ProbeResult {
	status: ModelHealthStatus;
	latencyMs: number | null;
	servedModel: string | null;
	reason: string | null;
}

/** Bank one sweep's merged values: upsert the fact row per class core. */
export const bankModelHealth = (
	store: ModelHealthStore,
	values: Map<string, ModelHealthFact>,
): number => {
	const ts = Date.now();
	let n = 0;
	for (const [core, fact] of values) {
		store.run(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, ts = excluded.ts",
			`${MODEL_HEALTH_PREFIX}${core}`,
			JSON.stringify(fact),
			"model-health-sweep",
			ts,
		);
		n++;
	}
	return n;
};

/** Read every live model-health fact; rows that no longer parse are dropped
 *  (schema law: drift fails the row, never the read). */
export const readModelHealthFacts = (
	store: ModelHealthStore,
): Map<string, ModelHealthFact> => {
	const out = new Map<string, ModelHealthFact>();
	try {
		for (const row of store
			.query("SELECT key, value FROM facts WHERE key LIKE 'model.health.%'")
			.all() as { key: string; value: string }[]) {
			const parsed = ModelHealthFact.safeParse(JSON.parse(row.value));
			if (parsed.success) out.set(row.key, parsed.data);
		}
	} catch {
		// fail-soft: a store without the facts table (report/board faces over
		// bare fixtures) degrades to no-facts — unavailable beats a crash
	}
	return out;
};

/** DOWN group cores for the report + board surfaces — fresh facts only
 *  (stale reads unknown, so a group that stopped being probed ages out of
 *  the DOWN display too). */
export const downModelGroups = (db: ModelHealthStore): string[] =>
	[...readModelHealthFacts(db).entries()]
		.filter(([, f]) => healthStatusOf(f) === "down")
		.map(([key]) => key.slice(MODEL_HEALTH_PREFIX.length));

/** A fact's effective status at `nowMs`: stale > MODEL_HEALTH_STALE_MS reads
 *  unknown — stale is never healthy (the mission's expiry law). */
export const healthStatusOf = (
	fact: ModelHealthFact | undefined,
	nowMs = Date.now(),
): ModelHealthStatus =>
	fact && nowMs - fact.ts < MODEL_HEALTH_STALE_MS ? fact.status : "unknown";

interface HealthCandidate {
	core: string;
	fact: ModelHealthFact;
}

/** Does `a` outrank `b` as the fallback target — freshness first (ts desc),
 *  then latency asc (nulls last), then key asc (deterministic). */
const outranks = (a: HealthCandidate, b: HealthCandidate): boolean =>
	a.fact.ts !== b.fact.ts
		? a.fact.ts > b.fact.ts
		: (a.fact.latencyMs ?? Number.POSITIVE_INFINITY) <
				(b.fact.latencyMs ?? Number.POSITIVE_INFINITY) ||
			((a.fact.latencyMs ?? Number.POSITIVE_INFINITY) ===
				(b.fact.latencyMs ?? Number.POSITIVE_INFINITY) &&
				a.core < b.core);

/** W2264: the capability class a model group belongs to — the FIRST class
 *  whose members wireModelMatch the group (conf order; dash-extension law,
 *  so `zai-glm-5.3-flash` matches a `glm-5.3-flash` member). Undefined when
 *  the taxonomy is absent/empty (no gating) or the group sits in none —
 *  callers decide both policies. */
export const classOfModel = (
	model: string,
	classes?: Record<string, string[]>,
): string | undefined => {
	if (!classes) return undefined;
	for (const [cls, members] of Object.entries(classes))
		for (const m of members)
			if (wireModelMatch(model, m) === "match") return cls;
	return undefined;
};

/** The fallback target for a DOWN/unknown pinned group: the freshest healthy
 *  group (outranks above), the pinned core excluded, `null` when nothing is
 *  fresh-healthy — the pinned model stands (honest, no invented fallback).
 *  W2264: `classes` (the machine conf taxonomy) gates eligibility — when set,
 *  a candidate must share the pin's class; the pin's own class is computed
 *  once (a class member's own class; otherwise null). */
export const pickHealthyGroup = (
	facts: Map<string, ModelHealthFact>,
	pinned: string,
	nowMs = Date.now(),
	classes?: Record<string, string[]>,
): { group: string; core: string; fact: ModelHealthFact } | null => {
	let best: HealthCandidate | null = null;
	const pinClass = classOfModel(pinned, classes);
	for (const [key, fact] of facts) {
		if (!key.startsWith(MODEL_HEALTH_PREFIX)) continue;
		const core = key.slice(MODEL_HEALTH_PREFIX.length);
		if (
			wireModelMatch(pinned, core) === "match" ||
			healthStatusOf(fact, nowMs) !== "up"
		)
			continue;
		if (classes && classOfModel(core, classes) !== pinClass) continue;
		const cand = { core, fact };
		if (!best || outranks(cand, best)) best = cand;
	}
	return best
		? { group: best.fact.wireId ?? best.core, core: best.core, fact: best.fact }
		: null;
};

/** The dispatch (lane-launch) and review-scheduler pin-layer fallback (the
 *  W2194 second half): when the lane's pinned model is DOWN/unknown per the
 *  fresh model.health facts, re-pin to the freshest healthy group.
 *  W2264: the eligible pool is the pin's OWN capability class (the machine
 *  conf taxonomy via modelCapabilityClasses() at the call sites) — a coding
 *  lane is never re-pinned into a foreign class even when it is freshest;
 *  none eligible → the pin stands (fail closed). Loud + recorded — never a
 *  silent alias (the W1302.6 wire audit still grades SERVED vs REQUESTED),
 *  and the note carries the target's MEASURED served model. */
export const rePinModelPick = (
	store: ModelHealthStore,
	pinned: string | undefined,
	classes?: Record<string, string[]>,
): { model?: string; note: string | null } => {
	if (!pinned) return { note: null };
	const facts = readModelHealthFacts(store);
	// no facts banked at all = the sweep hasn't spoken — silence, not an
	// unknown verdict (a NOTE on every launch of an unprobed fleet is noise)
	if (facts.size === 0) return { note: null };
	// the freshest row whose class matches the pin (wireModelMatch — hub
	// routing prefixes like `zai-` fold into the same class)
	let pinFact: ModelHealthFact | undefined;
	for (const [key, f] of facts) {
		if (!key.startsWith(MODEL_HEALTH_PREFIX)) continue;
		const core = key.slice(MODEL_HEALTH_PREFIX.length);
		if (
			wireModelMatch(pinned, core) === "match" &&
			(!pinFact || f.ts > pinFact.ts)
		)
			pinFact = f;
	}
	const pin = healthStatusOf(pinFact);
	if (pin === "up") return { note: null };
	const alt = pickHealthyGroup(facts, pinned, Date.now(), classes);
	if (!alt)
		return {
			note: `NOTE — model ${pinned} is ${pin} and no same-class healthy group is fresh; pin stands (no fallback invented)`,
		};
	const served = alt.fact.servedModel ?? alt.fact.wireId ?? alt.core;
	return {
		model: alt.group,
		note: `NOTE — model ${pinned} is ${pin}; re-pinned to ${alt.group} (served by ${alt.fact.hub} as ${served}, ${alt.fact.latencyMs}ms; was ${pinned})`,
	};
};

/** One hub's sequential, staggered probe pass over its catalog groups —
 *  never a burst (W779 heartbeat discipline: bounded work per tick). */
const probeHubGroups = async (
	hub: HealthHub,
	groups: string[],
	probe: typeof probeModelGroup,
): Promise<(ModelHealthFact & { wireId: string })[]> => {
	const rows: (ModelHealthFact & { wireId: string })[] = [];
	for (const group of groups) {
		if (rows.length > 0) await Bun.sleep(MODEL_HEALTH_STAGGER_MS);
		const r = await probe({
			url: hub.url,
			key: hub.key,
			group,
			timeoutMs: MODEL_HEALTH_PROBE_TIMEOUT_MS,
		});
		rows.push({
			status: r.status,
			latencyMs: r.latencyMs,
			servedModel: r.servedModel,
			ts: Date.now(),
			hub: hub.label,
			wireId: group,
			reason: r.reason,
		});
	}
	return rows;
};

export interface HubSweepSummary {
	hub: string;
	groups: number;
	catalogUp: boolean;
}

export interface SweepSummary {
	hubs: HubSweepSummary[];
	banked: number;
	down: string[];
}

export interface SweepDeps {
	resolveHubs?: (env: NodeJS.ProcessEnv) => HealthHub[];
	fetchCatalog?: typeof fetchHubCatalog;
	probe?: typeof probeModelGroup;
	store?: ModelHealthStore;
}

/** One sweep pass: resolve the fan-out targets, probe each hub's catalog
 *  groups through its own buckle (hubs parallel, groups staggered), merge
 *  per class core, bank when a store rides in. Pure-async — tests inject
 *  every dep. */
export const sweepOnce = async (
	deps: SweepDeps = {},
): Promise<SweepSummary> => {
	const resolveHubs = deps.resolveHubs ?? resolveHealthHubs;
	const fetchCatalog = deps.fetchCatalog ?? fetchHubCatalog;
	const probe = deps.probe ?? probeModelGroup;
	const perHub = await Promise.all(
		resolveHubs().map(async (hub) => {
			const groups = await fetchCatalog(
				hub.url,
				hub.key,
				MODEL_HEALTH_PROBE_TIMEOUT_MS,
			);
			if (!groups) return { hub: hub.label, rows: [], catalogUp: false };
			const rows = await probeHubGroups(hub, groups, probe);
			return { hub: hub.label, rows, catalogUp: true };
		}),
	);
	const merged = mergedGroupValues(perHub.flatMap((h) => h.rows));
	const banked = deps.store ? bankModelHealth(deps.store, merged) : 0;
	return {
		hubs: perHub.map(({ hub, rows, catalogUp }) => ({
			hub,
			groups: rows.length,
			catalogUp,
		})),
		banked,
		down: [...merged.entries()]
			.filter(([, f]) => f.status === "down")
			.map(([core]) => core),
	};
};
