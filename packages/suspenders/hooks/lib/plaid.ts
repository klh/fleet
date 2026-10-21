// hooks/lib/plaid.ts — the plaid posture. Copilot and Z.ai are distinct
// provider pools. Baselines guide fair initial fill, then each healthy pool
// can keep growing; there is no numerical lane ceiling. One provider never
// impersonates the other's route; a fully walled provider contributes zero
// lanes (surfaced loudly). Every lane rides a real, quota-aware,
// traced route; personal ChatGPT/Claude CLI seats are never labeled IKEA —
// the ikea-* prefix is reserved for Copilot-provider routes, and only
// plaid-dispatched lanes carry a route fact at all.
//
// State: `.fleet/posture` (steady|plaid, parked/W503 file, fail-safe narrow
// — junk reads steady) + the `plaid.posture` fact dispatch stamps each
// cycle, the board's UI-agreement read (what dispatch OBSERVED, never what
// a file somewhere says). Availability = the W374 per-provider quota
// penalty (exec-quota.ts) + the executor binary probe; a walled route's
// share redistributes WITHIN its pool in table order.
// This replaces the parked/W503 unbounded fan-out semantics.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ProviderPenalty } from "./exec-quota.ts";
import { quotaProviderPenalty } from "./exec-quota.ts";
import { adapterFor } from "./executors/registry.ts";
import type { GovernorStore } from "./govdb.ts";

// ── posture file (.fleet/posture) ─────────────────────────────────────────

export type Posture = "steady" | "plaid";

/** Validated parse: case/space tolerant; junk → null (fail-safe narrow). */
export const parsePosture = (raw?: string): Posture | null => {
	const v = raw?.trim().toLowerCase();
	return v === "steady" || v === "plaid" ? v : null;
};

/** `.fleet/posture` contents; absent/unreadable/junk = steady. */
export const readPosture = (fleetDir: string): Posture => {
	try {
		return (
			parsePosture(readFileSync(`${fleetDir}/posture`, "utf8")) ?? "steady"
		);
	} catch {
		return "steady";
	}
};

export const writePosture = (fleetDir: string, p: Posture): void => {
	mkdirSync(fleetDir, { recursive: true });
	writeFileSync(`${fleetDir}/posture`, `${p}\n`);
};

// ── baseline: fair initial fill, never a ceiling ──────────────────────────

/** A fair-fill threshold for each provider; no maximum is implied. */
export const PLAID = {
	baseline: 6,
} as const;

/** The two plaid provider pools (owner-named). */
export const POOL_PROVIDERS = ["copilot", "zai"] as const;
export type PoolProvider = (typeof POOL_PROVIDERS)[number];

/** Steady uses its requested target; plaid has no total-width target. */
export const postureWidth = (p: Posture, target: number): number | null =>
	p === "plaid" ? null : target;

// ── routes: the owner-defined ride table (config-over-code: the machine
// suspenders-board.json `plaid_routes` overrides these rows) ──────────────

export interface PlaidRoute {
	/** Route key — `ikea-*` is reserved for Copilot-provider rides. */
	name: string;
	/** Honest human label (the board shows it verbatim). */
	label: string;
	/** Executor chain token ("codex", "claude"); adapterFor resolves the bin. */
	executor: string;
	/** Belt model/group pin; null = the executor CLI rides its own config. */
	model: string | null;
	/** exec-quota provider key the route's health reads; null = exempt. */
	provider: string | null;
}

/** Owner definition 2026-10-19; W989 truthfulness pass 2026-10-20: the
 *  codex executor rides the PERSONAL Codex CLI seat — it never touches the
 *  Copilot provider through Buckle — so it carries no ikea-* name and no
 *  pool provider (a personal seat is never pool capacity; bin-probed only,
 *  dispatchable only where a route pick reaches it outside the pools). The
 *  Copilot ride is the claude CLI pinned to claude-sonnet-5 (the Copilot
 *  seat serves the Anthropic wire). Table order IS the defined fallback:
 *  Copilot → glm (glm-flash the floor) → personal codex. */
export const PLAID_ROUTES: PlaidRoute[] = [
	{
		name: "ikea-sonnet",
		label: "IKEA Copilot Sonnet",
		executor: "claude",
		model: "claude-sonnet-5",
		provider: "copilot",
	},
	{
		name: "glm-5.3-flash",
		label: "GLM 5.3 Flash",
		executor: "claude",
		model: "glm-5.3-flash",
		provider: "zai",
	},
	{
		name: "codex-personal",
		label: "Codex (personal seat)",
		executor: "codex",
		model: null,
		provider: null,
	},
];

/** Route rows → validated table; junk rows/fields fall back to defaults
 *  (fail-safe narrow, same doctrine as readPosture). */
export const plaidRoutes = (rows?: unknown): PlaidRoute[] => {
	if (!Array.isArray(rows) || rows.length === 0) return PLAID_ROUTES;
	const out: PlaidRoute[] = [];
	for (const raw of rows) {
		const r = raw as Partial<PlaidRoute>;
		if (typeof r.name !== "string" || !r.name.trim()) return PLAID_ROUTES;
		if (typeof r.executor !== "string" || !r.executor.trim())
			return PLAID_ROUTES;
		if (r.name.toLowerCase().startsWith("ikea-") && r.provider !== "copilot")
			return PLAID_ROUTES; // the IKEA label is reserved (honesty law)
		const label =
			typeof r.label === "string" && r.label.trim()
				? r.label.trim()
				: r.name.trim();
		out.push({
			name: r.name.trim(),
			label,
			executor: r.executor.trim(),
			model:
				typeof r.model === "string" && r.model.trim() ? r.model.trim() : null,
			provider:
				typeof r.provider === "string" && r.provider.trim()
					? r.provider.trim()
					: null,
		});
	}
	return out;
};

// ── health, load, assignment ──────────────────────────────────────────────

/** Per-route availability: the provider quota penalty outranks, then the
 *  executor binary probe. Unavailable routes show their reason in the UI —
 *  never a silent skip. */
export const plaidHealth = (
	quota: ProviderPenalty,
): Map<string, string | null> => {
	const health = new Map<string, string | null>();
	for (const r of plaidRouteTable()) {
		const penalty = r.provider ? quota.get(r.provider) : null;
		if (penalty) {
			health.set(r.name, penalty);
			continue;
		}
		const bin = adapterFor(r.executor).bin;
		if (!Bun.which(bin))
			health.set(r.name, `executor binary ${bin} not on PATH`);
		else health.set(r.name, null);
	}
	return health;
};

// machine-level override hook — plaidRoutes(rows) is pure; the board and
// dispatch both read the same machine file so config and UI agree by
// construction. Junk machine config = the committed defaults (fail-safe).
let tableOverride: (() => PlaidRoute[]) | null = null;
/** Set the route-table source (board-config's validated rows). */
export const setPlaidRouteSource = (src: () => PlaidRoute[]): void => {
	tableOverride = src;
};
const plaidRouteTable = (): PlaidRoute[] => tableOverride?.() ?? PLAID_ROUTES;

// ── W989: the configured-model probe (routes must reach their model
// through the buckle front — W1019 lesson: a pin the front can't serve
// launches a lane that 502s on its first request) ─────────────────────────

/** GET <front>/v1/models → served model ids; null = no evidence (front
 *  unreachable/odd shape). W1102.1: the plaid posture FAILS CLOSED on no
 *  evidence — an unreachable/unparseable catalog is `null`, a reachable
 *  empty catalog is `[]` (the front answering with zero models is honest
 *  evidence every pin is unserved). No evidence never walling was the
 *  W989 doctrine; W1102.1 keeps quota+bin as walls but adds the catalog
 *  availability signal for plaid launch gating. */
export const PLAID_PROBE_TIMEOUT_MS = 1500;
export const fetchModelCatalog = async (
	front: string | null,
	timeoutMs = PLAID_PROBE_TIMEOUT_MS,
	token?: string | null,
): Promise<string[] | null> => {
	if (!front) return null;
	try {
		const r = await fetch(`${front.replace(/\/$/, "")}/v1/models`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: token ? { authorization: `Bearer ${token}` } : {},
		});
		if (!r.ok) return null;
		const j = (await r.json()) as { data?: { id?: unknown }[] };
		if (!Array.isArray(j.data)) return null;
		const ids = j.data
			.map((d) => (typeof d?.id === "string" ? d.id : ""))
			.filter(Boolean);
		return ids; // [] = reachable empty catalog (valid evidence)
	} catch {
		return null; // front down/timeout — unavailable, not empty
	}
};

/** Per-route model health over a fetched catalog. W1102.1 typed states:
 *  `null` return = catalog UNAVAILABLE (no evidence — plaid launch holds
 *  fail-closed), a Map = the catalog was read (empty map impossible: every
 *  route gets an entry; `[]` catalog walls every pinned route — a
 *  reachable front serving zero models is honest evidence). Pure — tests
 *  feed the catalog. */
export const plaidModelHealth = (
	routes: PlaidRoute[],
	catalog: string[] | null,
): Map<string, string | null> | null => {
	if (catalog === null) return null; // unavailable ≠ empty
	const served = new Set(catalog);
	const health = new Map<string, string | null>();
	for (const r of routes) {
		health.set(
			r.name,
			r.model && !served.has(r.model)
				? `model ${r.model} not served at the buckle front`
				: null,
		);
	}
	return health;
};

/** Dispatch-side one-shot: the live route table probed against the front
 *  (probeBuckleFront's url; null = no belt). The front's /v1/models is
 *  auth-gated — callers pass the machine conf's admin key (belt.env);
 *  absent key = 401 = catalog unavailable → null (plaid holds). One call
 *  per dispatch run. */
export const plaidProbeHealth = async (
	front: string | null,
	token?: string | null,
): Promise<Map<string, string | null> | null> =>
	plaidModelHealth(
		plaidRouteTable(),
		await fetchModelCatalog(front, PLAID_PROBE_TIMEOUT_MS, token),
	);

/** First non-null reason wins (quota outranks bin outranks the model
 *  probe — callers build `base` in that order, `extra` is the probe). */
export const mergePlaidHealth = (
	base: Map<string, string | null>,
	extra: Map<string, string | null> | null | undefined,
): Map<string, string | null> => {
	if (!extra) return base;
	const merged = new Map(base);
	for (const [k, v] of extra) if (v && !merged.get(k)) merged.set(k, v);
	return merged;
};

// ── store reads/writes: lane.<sid>.route + plaid.posture facts ────────────

/** Live-lane load per route: route facts over the given live sids only —
 *  dead lanes' stale facts never count. */
export const routeLoadOf = (
	store: GovernorStore,
	liveSids: string[],
): Map<string, number> => {
	const load = new Map<string, number>();
	if (!liveSids.length) return load;
	const live = new Set(liveSids);
	try {
		for (const r of store
			.query("SELECT key, value FROM facts WHERE key GLOB 'lane.*.route'")
			.all() as { key: string; value: string }[]) {
			const sid = r.key.slice("lane.".length, -".route".length);
			if (!live.has(sid)) continue;
			load.set(r.value, (load.get(r.value) ?? 0) + 1);
		}
	} catch {} // pre-facts db — no load evidence
	return load;
};

/** Dispatch trace: fact lane.<sid>.route (source 'dispatch') — the plaid
 *  attribution joining lanes to routes in the board + report. */
export const recordLaneRoute = (
	store: GovernorStore,
	sid: string,
	routeName: string,
): void => {
	store
		.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
		)
		.run(`lane.${sid}.route`, routeName, Date.now());
};

/** The posture dispatch last observed — the board's UI-agreement read. */
export const postureFactOf = (store: GovernorStore): Posture =>
	parsePosture(
		(
			store
				.query("SELECT value FROM facts WHERE key = 'plaid.posture'")
				.get() as { value: string } | null
		)?.value,
	) ?? "steady";

export const recordPostureFact = (store: GovernorStore, p: Posture): void => {
	store
		.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
		)
		.run("plaid.posture", p, Date.now());
};

// ── the plan: which provider pool takes the next lane ─────────────────────

export interface PlaidPlan {
	/** true = dispatch a lane now; false = paused (reason says why). */
	open: boolean;
	/** Where the next lane rides; null when paused. */
	provider: PoolProvider | null;
	/** baseline fair-fill or unconstrained balanced growth. */
	phase: "baseline" | "growth" | null;
	/** Pause reason when closed. */
	reason: string | null;
}

/** Healthy pool providers in table order — the plan's eligible set. */
export const plaidHealthyPools = (
	routes: PlaidRoute[],
	health: Map<string, string | null>,
): PoolProvider[] =>
	[
		...new Set(
			routes
				.filter((r) => !health.get(r.name) && r.provider)
				.map((r) => r.provider as PoolProvider),
		),
	].filter((p): p is PoolProvider =>
		(POOL_PROVIDERS as readonly string[]).includes(p),
	);

/** Next-lane allocation: fill healthy provider baselines, then pick the
 *  emptiest healthy pool indefinitely. Refusal/quota health is the stop. */
export const plaidPlan = (
	routes: PlaidRoute[],
	health: Map<string, string | null>,
	liveByProvider: Map<string, number>,
): PlaidPlan => {
	const healthy = plaidHealthyPools(routes, health);
	const live = (p: PoolProvider): number => liveByProvider.get(p) ?? 0;
	// deterministic provider order: emptiest first, then table order
	const byEmptiest = (a: PoolProvider, b: PoolProvider): number =>
		live(a) - live(b) ||
		routes.findIndex((r) => r.provider === a) -
			routes.findIndex((r) => r.provider === b);
	const base = healthy.filter((p) => live(p) < PLAID.baseline).sort(byEmptiest);
	const first = base[0];
	if (base.length && first)
		return { open: true, provider: first, phase: "baseline", reason: null };
	const nextGrowth = healthy.sort(byEmptiest)[0];
	if (nextGrowth)
		return {
			open: true,
			provider: nextGrowth,
			phase: "growth",
			reason: null,
		};
	return {
		open: false,
		provider: null,
		phase: null,
		reason: "plaid: no healthy route in any pool — dispatch paused",
	};
};

// ── within-pool route assignment ──────────────────────────────────────────

export interface PlaidAssignment {
	route: PlaidRoute;
	/** phase from the plan that chose this pool (telemetry only). */
	phase: "baseline" | "growth" | null;
}

/** Least-loaded healthy route of the picked pool, ordinal-balanced ties
 *  (round-robin within a dispatch cycle), table order as final tiebreak.
 *  A walled route's share redistributes WITHIN its pool by construction. */
export const plaidAssign = (
	routes: PlaidRoute[],
	health: Map<string, string | null>,
	load: Map<string, number>,
	provider: PoolProvider,
	ordinal: number,
	phase: "baseline" | "growth" | null = null,
): PlaidAssignment => {
	const pool = routes.filter(
		(r) => r.provider === provider && !health.get(r.name),
	);
	let minLoad = Number.MAX_SAFE_INTEGER;
	for (const r of pool) minLoad = Math.min(minLoad, load.get(r.name) ?? 0);
	const tied = pool.filter((r) => (load.get(r.name) ?? 0) === minLoad);
	const route = tied[ordinal % tied.length];
	if (!route)
		throw new Error("plaidAssign: no healthy route in the picked pool");
	return { route, phase };
};

// ── the UI-agreement status view ──────────────────────────────────────────

export interface PlaidRouteView extends PlaidRoute {
	available: boolean;
	reason: string | null;
	lanes: number;
}

export interface PlaidStatus {
	posture: Posture;
	/** Null means dispatch continues while healthy READY work exists. */
	width: null;
	/** Live lanes per pool: copilot + zai. */
	live: { copilot: number; zai: number };
	/** Baseline minimums still to fill, per pool. */
	baselineOpen: { copilot: number; zai: number };
	/** true when NO route is healthy anywhere. */
	fallback: boolean;
	routes: PlaidRouteView[];
}

const poolTotalOf = (
	routes: PlaidRoute[],
	load: Map<string, number>,
	provider: string,
): number =>
	routes
		.filter((r) => r.provider === provider)
		.reduce((sum, r) => sum + (load.get(r.name) ?? 0), 0);

export const plaidStatus = (
	store: GovernorStore,
	liveSids: string[],
): PlaidStatus => {
	const routes = plaidRouteTable();
	const quota = quotaProviderPenalty(store);
	const health = plaidHealth(quota);
	const load = routeLoadOf(store, liveSids);
	return {
		posture: postureFactOf(store),
		width: null,
		live: {
			copilot: poolTotalOf(routes, load, "copilot"),
			zai: poolTotalOf(routes, load, "zai"),
		},
		baselineOpen: {
			copilot: Math.max(
				0,
				PLAID.baseline - poolTotalOf(routes, load, "copilot"),
			),
			zai: Math.max(0, PLAID.baseline - poolTotalOf(routes, load, "zai")),
		},
		fallback: plaidHealthyPools(routes, health).length === 0,
		routes: routes.map((r) => ({
			...r,
			available: !health.get(r.name),
			reason: health.get(r.name) ?? null,
			lanes: load.get(r.name) ?? 0,
		})),
	};
};

// ── the pick override (route → honest pick fields) ────────────────────────

export interface PlaidPick {
	name: string;
	agent: string;
	model: string | null;
	bin: string;
	fallbackModels: string[];
}

/** Route → pick fields: the executor/model facts carry the REAL ride (never
 *  an ikea-* executor name — that prefix lives in route names only), the
 *  agent label carries the route label, and same-bin sibling routes ride
 *  the native --fallback-model tail (in-process recovery when a provider
 *  walls mid-lane). */
export const plaidPickOf = (
	hub: string | null,
	route: PlaidRoute,
	routes: PlaidRoute[],
): PlaidPick => {
	const bin = adapterFor(route.executor).bin;
	const siblings = routes.filter(
		(r) =>
			r.name !== route.name && adapterFor(r.executor).bin === bin && r.model,
	);
	return {
		name: route.model ?? route.executor,
		agent: `${hub ? `[${hub.toUpperCase()}] ` : ""}${route.label}`,
		model: route.model,
		bin,
		fallbackModels: siblings.flatMap((r) => (r.model ? [r.model] : [])),
	};
};

// ── the dispatch-side entry: one call assembles the full gate state ───────

/** One dispatch decision: route table + health + load + plan assembled
 *  once — the shape dispatch-next's plaid override consumes. W1102.1
 *  fail-closed: an UNAVAILABLE catalog (modelHealth null) closes the plan
 *  with an explicit reason — no evidence never launches a plaid lane. */
export const plaidGate = (
	store: GovernorStore,
	liveSids: string[],
	quota: ProviderPenalty,
	modelHealth?: Map<string, string | null> | null,
): {
	routes: PlaidRoute[];
	health: Map<string, string | null>;
	load: Map<string, number>;
	plan: PlaidPlan;
} => {
	const routes = plaidRouteTable();
	if (modelHealth === null)
		return {
			routes,
			health: plaidHealth(quota),
			load: new Map(),
			plan: {
				open: false,
				provider: null,
				phase: null,
				reason: PLAID_CATALOG_UNAVAILABLE,
			},
		};
	const health = mergePlaidHealth(plaidHealth(quota), modelHealth);
	const load = routeLoadOf(store, liveSids);
	const liveBy = new Map(
		POOL_PROVIDERS.map((p) => [p, poolTotalOf(routes, load, p)]),
	);
	return {
		routes,
		health,
		load,
		plan: plaidPlan(routes, health, liveBy),
	};
};

// ── the dispatch override, end to end ─────────────────────────────────────

/** The loud hold reason when the catalog probe ran but the front gave no
 *  evidence (unreachable/401/odd shape ≠ a healthy empty catalog). */
export const PLAID_CATALOG_UNAVAILABLE =
	"plaid: buckle front /v1/models catalog unavailable — launch held (fail-closed)";

export interface PlaidDispatch {
	/** non-null = SKIP dispatch with this reason (pool plan closed). */
	skip: string | null;
	/** Spread into the execPick result when not skipped. */
	pick: Partial<PlaidPick>;
	/** The route this lane rides (the trace fact's value). */
	routeName: string | null;
	/** The loud admission NOTE body (caller prints with NOTE — prefix). */
	note: string | null;
}

/** The full plaid override: gate → assign → honest pick fields → trace
 *  shape, one call. Dispatch consumes: skip → SKIP+return; else spread
 *  pick, bank routeName for the trace, print note. Steady posture never
 *  calls this — the .prefer chain stands (W228). */
export const plaidDispatch = (o: {
	store: GovernorStore;
	sids: string[];
	quota: ProviderPenalty;
	ordinal: number;
	hub: string | null;
	routePin?: string;
	modelHealth?: Map<string, string | null> | null;
}): PlaidDispatch => {
	const g = plaidGate(o.store, o.sids, o.quota, o.modelHealth);
	// W1102.1 fail-closed: an unavailable catalog holds EVERY plaid launch,
	// pinned or pooled (the routePin branch below reads per-route health —
	// it must never bypass the availability signal)
	if (o.modelHealth === null)
		return {
			skip: PLAID_CATALOG_UNAVAILABLE,
			pick: {},
			routeName: null,
			note: null,
		};
	if (o.routePin) {
		const route = g.routes.find((r) => r.name === o.routePin);
		if (
			!route?.provider ||
			!(POOL_PROVIDERS as readonly string[]).includes(route.provider)
		)
			return {
				skip: `plaid route ${o.routePin} is not a configured pool route`,
				pick: {},
				routeName: null,
				note: null,
			};
		const health = g.health.get(route.name);
		if (health)
			return {
				skip: `plaid route ${o.routePin} unavailable: ${health}`,
				pick: {},
				routeName: null,
				note: null,
			};
		const liveBy = new Map(
			POOL_PROVIDERS.map((p) => [p, poolTotalOf(g.routes, g.load, p)]),
		);
		const plan = plaidPlan([route], g.health, liveBy);
		if (!plan.open)
			return { skip: plan.reason, pick: {}, routeName: null, note: null };
		return {
			skip: null,
			pick: plaidPickOf(o.hub, route, [route]),
			routeName: route.name,
			note: `plaid: explicit route ${route.name} (${route.label})`,
		};
	}
	if (!g.plan.open)
		return { skip: g.plan.reason, pick: {}, routeName: null, note: null };
	const assign = plaidAssign(
		g.routes,
		g.health,
		g.load,
		g.plan.provider,
		o.ordinal,
		g.plan.phase,
	);
	return {
		skip: null,
		pick: plaidPickOf(o.hub, assign.route, g.routes),
		routeName: assign.route.name,
		note: `plaid: ${g.plan.provider} pool, ${g.plan.phase} phase → ${assign.route.name} (${assign.route.label})`,
	};
};

/** The trace: route fact + observed posture, ONLY plaid-dispatched lanes. */
export const recordPlaidTrace = (
	store: GovernorStore,
	sid: string,
	posture: Posture,
	routeName: string | null,
): void => {
	if (posture !== "plaid" || !routeName) return;
	recordLaneRoute(store, sid, routeName);
	recordPostureFact(store, posture);
};
