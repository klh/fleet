// hooks/lib/capacity/ramp-run.ts — W1713 the bounded ramp driver. Closed-loop
// virtual lanes (one scoped key + one /w/<sid> identity each) hold a target
// concurrency per step; the first throttle (provider429 / local503 / local429)
// stops the WHOLE run, a latency/error threshold stops that route's ramp.
// Every dependency is injected (fetch, clock, sleep, mint/revoke, gateway
// probe), so the same driver runs against a fake gateway in the e2e spec.
import type { ToolMode } from "./ramp-classify.ts";
import type { GatewayInflight } from "./ramp-gateway.ts";
import { sendOne, type SendCtx, type SendLane } from "./ramp-send.ts";
import {
	evaluateStop,
	routeVerdict,
	summarizeStep,
	type RouteVerdict,
	type StepStats,
} from "./ramp-stats.ts";
import type {
	InflightSample,
	RampRoute,
	RequestRow,
	StopReason,
	StopRules,
} from "./ramp-types.ts";

export interface RampConfig {
	runId: string;
	/** virtual lane sid prefix; lane n is `<prefix>-<nn>` */
	lanePrefix: string;
	routes: RampRoute[];
	steps: number[];
	holdS: number;
	gapMs: number;
	maxRequests: number;
	maxMinutes: number;
	rules: StopRules;
	toolMode: ToolMode;
	maxOut: number;
	prefixTokens: number;
	requestTimeoutMs: number;
	sampleMs: number;
	drainMs: number;
}

export interface RampDeps {
	fetch: typeof fetch;
	front: string;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	mint: (sid: string) => Promise<{ key: string; keyId: string } | null>;
	revoke: (keyId: string) => Promise<boolean>;
	inflight: () => Promise<GatewayInflight | null>;
	/** called BEFORE the key is used, so a crash leaves a revocable manifest */
	onKey: (sid: string, keyId: string) => void;
	onRow: (row: RequestRow) => void;
	onStep: (s: StepStats) => void;
	signal: AbortSignal;
}

export interface RampStop {
	route: string | null;
	concurrency: number | null;
	reason: StopReason;
}

export interface RampKey {
	sid: string;
	keyId: string;
	revoked: boolean;
}

export interface RampResult {
	runId: string;
	startedMs: number;
	endedMs: number;
	requests: number;
	steps: StepStats[];
	verdicts: RouteVerdict[];
	/** the run-level stop (throttle / cap / mint / abort); null = every step ran clean */
	stop: RampStop | null;
	/** own lanes still in flight at the gateway after the drain wait (null = unobservable) */
	drainResidual: number | null;
	keys: RampKey[];
}

const RUN_LEVEL = new Set<StopReason>([
	"provider429",
	"local429",
	"local503",
	"mint_refused",
	"request_cap",
	"time_cap",
	"operator_abort",
]);

const sumPrefix = (m: Record<string, number>, prefix: string): number =>
	Object.entries(m).reduce(
		(n, [k, v]) => (k.startsWith(prefix) ? n + v : n),
		0,
	);

export async function runRamp(
	cfg: RampConfig,
	deps: RampDeps,
): Promise<RampResult> {
	const lanes: (SendLane & { keyId: string })[] = [];
	const keys: RampKey[] = [];
	const steps: StepStats[] = [];
	let requests = 0;
	const t0 = deps.now();

	const capStop = (): StopReason | null => {
		if (deps.signal.aborted) return "operator_abort";
		if (requests >= cfg.maxRequests) return "request_cap";
		return deps.now() - t0 >= cfg.maxMinutes * 60_000 ? "time_cap" : null;
	};

	const ensureLanes = async (n: number): Promise<boolean> => {
		while (lanes.length < n) {
			const sid = `${cfg.lanePrefix}-${String(lanes.length + 1).padStart(2, "0")}`;
			const k = await deps.mint(sid);
			if (k === null) return false;
			deps.onKey(sid, k.keyId);
			lanes.push({ sid, key: k.key, keyId: k.keyId });
			keys.push({ sid, keyId: k.keyId, revoked: false });
		}
		return true;
	};

	const runStep = async (
		route: RampRoute,
		n: number,
	): Promise<StopReason | null> => {
		const start = deps.now();
		const rows: RequestRow[] = [];
		const samples: InflightSample[] = [];
		const hard = new AbortController();
		const ctx: SendCtx = {
			fetch: deps.fetch,
			front: deps.front,
			now: deps.now,
			runId: cfg.runId,
			toolMode: cfg.toolMode,
			maxOut: cfg.maxOut,
			prefixTokens: cfg.prefixTokens,
			timeoutMs: cfg.requestTimeoutMs,
			abort: hard.signal,
		};
		let own = 0;
		let ownPeak = 0;
		let reason: StopReason | null = null;
		let drain: ReturnType<typeof setTimeout> | null = null;
		const trip = (r: StopReason): void => {
			if (reason !== null) return;
			reason = r;
			drain = setTimeout(() => hard.abort(), cfg.drainMs);
			drain.unref();
		};
		const onAbort = (): void => trip("operator_abort");
		deps.signal.addEventListener("abort", onAbort, { once: true });
		const snapshot = (): StepStats =>
			summarizeStep({
				route,
				concurrency: n,
				holdS: cfg.holdS,
				startMs: start,
				endMs: deps.now(),
				rows,
				samples,
				ownPeak,
			});

		const worker = async (lane: SendLane): Promise<void> => {
			while (reason === null && deps.now() - start < cfg.holdS * 1000) {
				const cap = capStop();
				if (cap !== null) return trip(cap);
				requests += 1;
				own += 1;
				ownPeak = Math.max(ownPeak, own);
				const row = await sendOne(ctx, route, n, lane);
				own -= 1;
				rows.push(row);
				deps.onRow(row);
				const live = evaluateStop(snapshot(), cfg.rules);
				if (live !== null) trip(live);
				if (reason === null && cfg.gapMs > 0) await deps.sleep(cfg.gapMs);
			}
		};

		let sampling = true;
		const sampler = (async (): Promise<void> => {
			while (sampling) {
				const g = await deps.inflight();
				samples.push({
					atMs: deps.now(),
					own,
					gateway: g?.active ?? null,
					gatewayOwn: g ? sumPrefix(g.byLane, cfg.lanePrefix) : null,
					gatewayModel: g ? (g.byModel[route.model] ?? 0) : null,
				});
				await deps.sleep(cfg.sampleMs);
			}
		})();

		try {
			await Promise.all(lanes.slice(0, n).map((l) => worker(l)));
		} finally {
			sampling = false;
			deps.signal.removeEventListener("abort", onAbort);
			if (drain !== null) clearTimeout(drain);
		}
		await sampler;
		const stats = snapshot();
		steps.push(stats);
		deps.onStep(stats);
		return reason ?? evaluateStop(stats, { ...cfg.rules, minSamples: 1 });
	};

	const rampRoute = async (route: RampRoute): Promise<RampStop | null> => {
		for (const n of cfg.steps) {
			const at = { route: route.name, concurrency: n };
			const cap = capStop();
			if (cap !== null) return { ...at, reason: cap };
			if (!(await ensureLanes(n))) return { ...at, reason: "mint_refused" };
			const reason = await runStep(route, n);
			if (reason === null) continue;
			return RUN_LEVEL.has(reason) ? { ...at, reason } : null;
		}
		return null;
	};

	const residual = async (): Promise<number | null> => {
		let left: number | null = null;
		for (let i = 0; i < 5; i += 1) {
			const g = await deps.inflight();
			left = g === null ? null : sumPrefix(g.byLane, cfg.lanePrefix);
			if (left === null || left === 0) return left;
			await deps.sleep(500);
		}
		return left;
	};

	let stop: RampStop | null = null;
	let drainResidual: number | null = null;
	try {
		for (const route of cfg.routes) {
			stop = await rampRoute(route);
			if (stop !== null) break;
		}
		drainResidual = await residual();
	} finally {
		await Promise.all(
			keys.map(async (k) => {
				k.revoked =
					(await deps.revoke(k.keyId)) || (await deps.revoke(k.keyId));
			}),
		);
	}
	return {
		runId: cfg.runId,
		startedMs: t0,
		endedMs: deps.now(),
		requests,
		steps,
		verdicts: cfg.routes.map((r) =>
			routeVerdict(
				r.name,
				steps.filter((s) => s.route === r.name),
				cfg.rules,
			),
		),
		stop,
		drainResidual,
		keys,
	};
}
