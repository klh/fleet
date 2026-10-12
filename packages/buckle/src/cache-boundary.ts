// src/cache-boundary.ts — W458.4: cache-boundary honesty + per-lane cache
// telemetry (spec: docs/starter-registry-architecture.md). Laws encoded:
// - a cache boundary is (provider, tenant, region, model): matching requests
//   reuse provider cache ONLY inside one boundary, and a matching entry
//   being present never guarantees a hit (routing + expiry decide);
// - tenant comes from the CREDENTIAL's identity, never from request text —
//   two requests on one key still ride isolated tenants when their
//   credentials differ;
// - cache keys are routing/accounting aids, never authorization controls:
//   boundary data may downgrade a reuse EXPECTATION (affinity, savings
//   claims) — it never grants, never relaxes, never collapses a tenant;
// - per-lane telemetry carries the boundary it rode, so no report can
//   claim cross-boundary savings as if they were in-boundary hits.
import { existsSync, appendFileSync, readFileSync } from "node:fs";

export type CacheBoundary = {
	/** anthropic | openai | local-mlx | … — the serving provider. */
	provider: string;
	/** Account/workspace identity the credential resolves to. */
	tenant: string;
	/** Processing region when the provider reports one ('' = unknown). */
	region: string;
	model: string;
};

/** Boundary identity: the exact join used for equality AND for telemetry
 *  attribution — one canonical string, no per-callsite re-joins. */
export const boundaryKey = (b: CacheBoundary): string =>
	[b.provider, b.tenant, b.region, b.model].join("|");

export const sameBoundary = (a: CacheBoundary, b: CacheBoundary): boolean =>
	boundaryKey(a) === boundaryKey(b);

export type HitExpectation =
	| "possible"
	| "impossible-boundary"
	| "impossible-model";

/** Reuse EXPECTATION between the boundary a request would ride and a prior
 *  entry's boundary. Possible ≠ guaranteed — only "the provider could hit
 *  it". Model mismatch is its own impossibility: even one tenant cannot
 *  reuse across models. */
export const hitExpectation = (
	route: CacheBoundary,
	prior: CacheBoundary,
): HitExpectation => {
	if (route.model !== prior.model) return "impossible-model";
	if (!sameBoundary(route, prior)) return "impossible-boundary";
	return "possible";
};

/** The anti-collapse guard: true only when affinity/pooling may treat two
 *  requests as one cache population. Tenant differs → NEVER, regardless of
 *  prefix/key equality (cache reuse must not authorize reading another
 *  tenant's history — the key is an accounting aid, not a gate). */
export const mayShareCachePopulation = (
	a: CacheBoundary,
	b: CacheBoundary,
): boolean => sameBoundary(a, b);

export type LaneCacheRow = {
	lane: string;
	task: string;
	boundary: CacheBoundary;
	usage: {
		in_tok: number;
		out_tok: number;
		cache_r: number;
		cache_c: number;
	};
	requests: number;
	wallMs: number;
	at: string;
};

/** Per-lane NDJSON telemetry log — append-only so a hub that comes back up
 *  (failover/restart) reads the same attribution back; rows are keyed by
 *  (lane, task) and survive process death by construction. */
export class LaneTelemetryLog {
	constructor(private readonly file: string) {}

	append(row: LaneCacheRow): void {
		appendFileSync(this.file, `${JSON.stringify(row)}\n`);
	}

	/** Rows in order; corrupt lines are skipped, never fatal (a hub must be
	 *  able to report from a damaged log without inventing data). */
	all(): LaneCacheRow[] {
		if (!existsSync(this.file)) return [];
		const rows: LaneCacheRow[] = [];
		for (const line of readFileSync(this.file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line) as LaneCacheRow);
			} catch {
				// damaged line — reported as absent, never fabricated
			}
		}
		return rows;
	}

	lane(name: string): LaneCacheRow[] {
		return this.all().filter((r) => r.lane === name);
	}

	/** Cache split for one lane: hits share of input that rode cache reads,
	 *  plus writes/misses as first-class numbers (never inferred). */
	summarize(name: string): {
		requests: number;
		inTok: number;
		outTok: number;
		cacheRead: number;
		cacheWrite: number;
		hitShare: number;
	} | null {
		const rows = this.lane(name);
		if (rows.length === 0) return null;
		const sum = rows.reduce(
			(acc, r) => ({
				requests: acc.requests + r.requests,
				inTok: acc.inTok + r.usage.in_tok,
				outTok: acc.outTok + r.usage.out_tok,
				cacheRead: acc.cacheRead + r.usage.cache_r,
				cacheWrite: acc.cacheWrite + r.usage.cache_c,
			}),
			{ requests: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 },
		);
		const input = sum.inTok + sum.cacheRead + sum.cacheWrite;
		return {
			...sum,
			hitShare: input === 0 ? 0 : sum.cacheRead / input,
		};
	}
}

/** Structural view of a pool deployment for boundary derivation — narrow
 *  on purpose: no upstreams.ts import (adapters pull heavy deps;
 *  cache-boundary stays leaf-pure). */
export type BoundaryDep = {
	dialect: string;
	url: string;
	adapter?: string;
	api_key_env?: string;
	adapter_config?: Record<string, unknown>;
};

/** The cache boundary a pool deployment serves. Tenant = the credential
 *  account identity — the api_key_env NAME (never the value); keyless
 *  (fleet-local) deployments fall back to the URL origin, the serving
 *  process identity. Region from adapter_config (vertex/azure carry one);
 *  the empty string = region-unknown. Unknown never MERGES boundaries —
 *  it only means less reuse gets claimed, never more (honest default).
 *  Provider = the wire family (adapter name ?? dialect). */
export const boundaryOfDeployment = (
	dep: BoundaryDep,
	model: string,
): CacheBoundary => ({
	provider: dep.adapter ?? dep.dialect,
	tenant: dep.api_key_env ?? new URL(dep.url).origin,
	region:
		typeof dep.adapter_config?.region === "string"
			? dep.adapter_config.region
			: "",
	model,
});

/** The credential ACCOUNT a deployment bills: the api_key_env name; the
 *  empty string = keyless (fleet-local workers — one self-hosted
 *  account). The anti-collapse gate plane: steering between same-account
 *  deployments never changes whose data lands where; cross-account
 *  steering would collapse tenant boundaries for cache savings and is
 *  refused. OpenAI org = the account env name; Claude workspace
 *  isolation = the workspace-scoped credential env name — one env name,
 *  one account. */
export const accountOfDeployment = (dep: BoundaryDep): string =>
	dep.api_key_env ?? "";

/** Region a deployment processes in (adapter_config), empty = unknown. */
export const regionOfDeployment = (dep: BoundaryDep): string =>
	typeof dep.adapter_config?.region === "string"
		? dep.adapter_config.region
		: "";

/** The ride-gate identity for cache-motivated steering: account + region
 *  + family + model. Steering may never change any of these — changing
 *  one means riding a different cache population, landing data on
 *  another account, or moving processing region. The URL origin is
 *  deliberately ABSENT: steering between same-account fleet workers is
 *  routing, not tenant collapse (each such ride stays inside the
 *  account the selection already chose). */
export const rideGateKeyOf = (dep: BoundaryDep, model: string): string =>
	[
		accountOfDeployment(dep),
		regionOfDeployment(dep),
		dep.adapter ?? dep.dialect,
		model,
	].join("|");
