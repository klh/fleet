// src/server.ts — the Bun.serve seam. Shadow port 127.0.0.1:4101 ONLY: a
// startup guard refuses 4100 (belt's live gateway address) from any source
// — flag, env, or code — until the owner flips it deliberately. Wires the
// W124 policy file, the upstream pool, the usage ledger, the router and the
// W125 servicemon standard (GET /status, GET /metrics) into one process.

import { homedir } from "node:os";
import { join } from "node:path";
import { RpcAdmission } from "./admission.ts";
import { PrefixAffinity } from "./affinity.ts";
import { LaneTelemetryLog } from "./cache-boundary.ts";
import { PrefixLedger } from "./cache-fingerprint.ts";
import { AidsLedger } from "./aids.ts";
import { CandidateTable } from "./candidates.ts";
import { startConnectEgress, type ConnectEgress } from "./connect-egress.ts";
import { Cooldowns } from "./cooldown.ts";
import { decideRoute } from "./decide.ts";
import { DietStore } from "./diet.ts";
import { directCall, Expander, pickLocalDirect } from "./expand.ts";
import { Federation } from "./gov/federation.ts";
import { ManifestSigner } from "./gov/federation-signing.ts";
import type {
	HubEntitlementsFactory,
	ManifestCrFactory,
	SpokeEnrollmentFactory,
	UsageIngestFactory,
} from "./gov/hub-seam.ts";
import { createGovernance, type GovernanceOpts } from "./gov/middleware.ts";
import { oidcGateOptsFromEnv } from "./gov/oidc-env.ts";
import { HttpProblem, problemOf } from "./http-kit.ts";
import { createLogger } from "./log.ts";
import {
	loadOverlay,
	overlayModuleAdaptation,
	overlayModuleGovSeam,
} from "./gov/overlay-loader.ts";
import { type AppDeps, createApp } from "./handlers.ts";
import { loadAccountPolicy } from "./account-policy.ts";
import { z } from "zod";
import { MAX_REQUEST_BODY_BYTES } from "./ingress-body.ts";
import type { RouteHint } from "./hints.ts";
import { Ledger } from "./ledger.ts";
import { ObservationOutbox } from "./observe.ts";
import { loadGatewayPolicy, loadPrefs, type GatewayPolicy } from "./policy.ts";
import { poolWarm, prewarm } from "./pool-warm.ts";
import { Preseeder } from "./preseed.ts";
import { LaneProjection, OutboxTailer } from "./projection.ts";
import { loadRepoPolicies } from "./repo-policy.ts";
import { resolveResidency, residencyFromEnv } from "./gov/residency.ts";
import { Router, type RouterMetrics } from "./router.ts";
import { servicemon } from "./servicemon.ts";
import type { Dialect } from "./upstreams.ts";
import { loadUpstreams } from "./upstreams.ts";

const serverLog = createLogger("server");

export const SHADOW_PORT = 4101;
export const FORBIDDEN_PORT = 4100;

/** W1106 (owner directive 2026-10-21): Bun's HTTP idle timeout is DISABLED
 *  globally — 0 for every request, no env knob, no per-request bypass. Bun
 *  ignores outgoing bytes when arming the timer (real-Bun canary), so any
 *  fixed value cuts quiet SSE turns (the ~120s fleet outage). Deadlines are
 *  Buckle's own: the wire.ts upstream idle/total guards + first-byte budget
 *  arbitrate every stream; this server imposes no connection timer. */
export const BUN_IDLE_TIMEOUT = 0;

export { MAX_REQUEST_BODY_BYTES } from "./ingress-body.ts";

/** W1246: dbPath default rides the runtime home (resolveNetworkDbPaths
 *  precedent) — a bare "buckle.db" resolves against the process cwd, which
 *  is how stray runs seeded repo-root junk. opts.dbPath and BUCKLE_DB win. */
export function defaultDbPath(
	env: { BUCKLE_DB?: string; HOME?: string } = process.env,
): string {
	return (
		env.BUCKLE_DB ??
		(env.HOME
			? join(env.HOME, ".claude", "local-llm", "buckle.db")
			: "buckle.db")
	);
}

/** W2173.7 zod-first: the data-shaped subset of ServerOpts — ports, paths,
 *  binds — is schema-defined; the type is derived, never hand-written. The
 *  auth slot carries code-shaped opts (function factories) — not wire data,
 *  it stays typed in ServerOpts itself. */
export const ServerDataOptsSchema = z.object({
	port: z.number().int().min(1).max(65535).optional(),
	/** Test seam for the app-owned request-body deadline; production uses 120s. */
	ingressBodyTimeoutMs: z.number().int().positive().optional(),
	hostname: z.string().min(1).optional(),
	dbPath: z.string().min(1).optional(),
	policyPath: z.string().min(1).optional(),
	upstreamsPath: z.string().min(1).optional(),
	prefsPath: z.string().min(1).optional(),
	/** W7 repo-policy gate: explicit path for the row file. */
	repoPolicyPath: z.string().min(1).optional(),
	/** W1265.1 account-policy path (absent = inert posture). */
	accountPolicyPath: z.string().min(1).optional(),
	/** W193: secrets home for the manifest-signing key (hub-only key law). */
	secretsHome: z.string().min(1).optional(),
});
export type ServerDataOpts = z.infer<typeof ServerDataOptsSchema>;

export interface ServerOpts extends ServerDataOpts {
	/** W7 repo-policy gate: explicit path for the row file; defaults chain
	 *  BUCKLE_REPO_POLICY → local-llm dir → the committed repo-policy.yaml. */
	repoPolicyPath?: string;
	// W141 governance: root break-glass key + optional W193 secrets-home opt
	// (BUCKLE_SECRETS_HOME env default) rides the auth slot's jwt config;
	// secretsHome moves to the schema'd data subset above.
	// W468: slots overrides the env-resolved admission-control pool caps.
	// W233: spokeEnrollment injects the enterprise overlay's enrollment
	// provider; unset = solo posture. W233.1:
	// hubEntitlements injects the entitlement-menu provider the same way.
	// W233.2: usageIngest injects the usage-ingest provider the same way.
	// W233.3: manifestCr injects the manifest + CR queue serving provider.
	auth?: Pick<
		GovernanceOpts,
		"rootKey" | "jwt" | "slots" | "adaptation" | "metrics"
	> & {
		spokeEnrollment?: SpokeEnrollmentFactory;
		hubEntitlements?: HubEntitlementsFactory;
		usageIngest?: UsageIngestFactory;
		manifestCr?: ManifestCrFactory;
	};
}

/** Port resolution with the 4100 guard; explicit arg wins over env. */
export function resolvePort(explicit?: number): number {
	if (explicit === FORBIDDEN_PORT) {
		throw problemOf("forbidden", {
			code: "buckle.port_forbidden",
			why: `port ${FORBIDDEN_PORT} is belt's live address — buckle refuses it until the owner flips it deliberately`,
		});
	}
	const raw = process.env.BUCKLE_PORT ?? "";
	const envPort = raw.length > 0 ? Number(raw) : NaN;
	const port = explicit ?? (Number.isFinite(envPort) ? envPort : SHADOW_PORT);
	if (port === FORBIDDEN_PORT) {
		throw problemOf("forbidden", {
			code: "buckle.port_forbidden",
			why: `BUCKLE_PORT=${FORBIDDEN_PORT} refused — buckle's shadow address is ${SHADOW_PORT}`,
		});
	}
	return port;
}

/** Build the app dependencies (policy → pool → ledger → router → app). */
export function buildDeps(
	opts: ServerOpts,
	port: number = SHADOW_PORT,
): AppDeps & { router: Router; policy: GatewayPolicy } {
	const policy = loadGatewayPolicy(opts.policyPath);
	const pool = loadUpstreams(opts.upstreamsPath);
	const prefs = loadPrefs(opts.prefsPath);
	const sm = servicemon({ service: "buckle", port });
	const ledger = new Ledger(opts.dbPath ?? defaultDbPath(), undefined, {
		onDrop: (kind, n) =>
			sm
				.counter(
					"buckle_ledger_dropped_total",
					"Ledger rows dropped after bounded flush retries.",
				)
				.inc({ kind }, n),
	});
	// W458.4 per-lane cache telemetry: append-only NDJSON next to the ledger
	// db (BUCKLE_LANE_CACHE_LOG overrides). Rows ride real lane-attributed
	// requests only — bare ingress appends nothing.
	const laneCache = new LaneTelemetryLog(
		process.env.BUCKLE_LANE_CACHE_LOG ??
			`${opts.dbPath ?? defaultDbPath()}.lane-cache.jsonl`,
	);
	// W926: per-boundary+lane prefix-fingerprint references — miss
	// classification rides the lane-cache rows (null causes when unwired).
	const prefixLedger = new PrefixLedger();
	// W142 knowledge aids: metering ledger + preseed builder on the same db
	// file (W133 wiring); policy slice from the shared routing-policy.json.
	const aids = new AidsLedger(opts.dbPath ?? defaultDbPath());
	const aidsPolicy = policy.aids ?? {};
	const preseeder = new Preseeder({
		policy: aidsPolicy,
		knowledgeUrl:
			aidsPolicy.preseed?.knowledge_url ?? process.env.BUCKLE_KNOWLEDGE_API,
	});
	const cooldowns = new Cooldowns(
		policy.allowed_fails ?? 3,
		policy.cooldown_time ?? 30,
	);
	// W235 locked residency floors: resolve once at boot (env + compiled
	// floor, tighten-only); the candidate table benches outsiders.
	const residency = resolveResidency(residencyFromEnv(process.env));
	const table = new CandidateTable({ pool, policy, cooldowns, residency });
	table.start();
	// W4 intent expansion: the local direct tier (aids.expand.group, default
	// local-swarm) serves the enhance digest — structurally local (never a
	// cloud row), one direct call, never the ladder (the W288 retarget).
	const expander = new Expander({
		policy: aidsPolicy,
		pick: (group) => pickLocalDirect(table.snapshot(), group),
		call: directCall,
	});
	const metrics: RouterMetrics = {
		attempt: (receipt) => {
			try {
				ledger.auditAttempt(receipt);
			} catch (e) {
				sm.counter(
					"buckle_trace_receipt_failures_total",
					"Attempt receipts rejected by the local ledger sink.",
				).inc();
				serverLog.warn(
					`buckle.trace_receipt_failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
		fallback: (tier) =>
			sm
				.counter(
					"buckle_ladder_fallbacks_total",
					"Ladder walks that fell through to a fallback tier.",
				)
				.inc({ tier }),
		cooldown: (dep) =>
			sm
				.counter(
					"buckle_cooldown_ejections_total",
					"Deployments benched into cooldown.",
				)
				.inc({ dep }),
		refused: (tier) =>
			sm
				.counter(
					"buckle_flashx_refusals_total",
					"flashx tiers refused in ladder walks (owner directive).",
				)
				.inc({ tier }),
	};
	const router = new Router(policy, { pool, metrics, cooldowns });
	// W450 bounded RPC admission: explicit overload (429 + Retry-After) past
	// the in-flight bound instead of uncontrolled memory growth.
	const admission = new RpcAdmission();
	// W143 speed pass: the warm-rate gate's servicemon counter + the boot
	// pre-warm — one GET /v1/models per unique deployment origin (the
	// gateway-config.ts precedent), so TLS/auth are established before the
	// first real request. Failed origins stay cold and honestly count a
	// pool_refill on their first dispatch.
	poolWarm.setSink((origin) =>
		sm
			.counter(
				"buckle_pool_refills_total",
				"Cold-connect transitions on the request path (pool_refill).",
			)
			.inc({ origin }),
	);
	void prewarm(pool);
	const decide = (input: {
		group: string;
		dialect: Dialect;
		hint: RouteHint | null;
		hintRaw: string;
		allowCross: boolean;
		providerPin?: string;
	}) => {
		const { providerPin, ...rest } = input;
		return decideRoute({
			...rest,
			candidates:
				providerPin === undefined
					? table.snapshot()
					: table.snapshot().filter((r) => r.dep.adapter === providerPin),
			prefs,
			fallbackGroups: rest.allowCross ? policy.fallbacks?.[rest.group] : [],
		});
	};
	const dbPath = opts.dbPath ?? defaultDbPath();
	const federation = new Federation({
		dbPath,
		ingressBodyTimeoutMs: opts.ingressBodyTimeoutMs,
		policy,
		pool,
		policyPath: opts.policyPath,
		signer: ManifestSigner.create(
			opts.secretsHome ??
				process.env.BUCKLE_SECRETS_HOME ??
				join(process.env.HOME ?? homedir(), ".claude", "local-llm"),
		),
		spokeEnrollment: opts.auth?.spokeEnrollment,
		usageIngest: opts.auth?.usageIngest,
		hubEntitlements: opts.auth?.hubEntitlements,
		manifestCr: opts.auth?.manifestCr,
	});
	// W7 repo-policy gate: the row file loads once at boot; absent file =
	// zero rows = engine inert (a fresh spoke without rows is valid).
	const repoPolicy = loadRepoPolicies(opts.repoPolicyPath);
	// W1265.1 account policy: the repo-tier class table loads once at boot
	// (config-over-code; absent config = inert posture, logged per the
	// log-at-startup law so the operator SEES the boundary state).
	const accountPolicy = loadAccountPolicy(opts.accountPolicyPath);
	serverLog.info(
		`account policy ` +
			(accountPolicy.source === "none"
				? "inert — no repo-tier-policy configured (the boundary is off)"
				: `active from ${accountPolicy.source} (${String(accountPolicy.doc.classes.length)} classes)`),
	);
	// W207 trajectory pruning: the diet sidestore rides the shared buckle db
	// (the AidsLedger wiring precedent); policy still gates the pass OFF.
	const diet = new DietStore(dbPath);
	const affinity = new PrefixAffinity();
	// W461 stage 2: the lane-observation outbox. BUCKLE_OBSERVATIONS_PATH
	// (config-over-code) enables it; unset = observations inert.
	const obsPath = process.env.BUCKLE_OBSERVATIONS_PATH;
	const observations = obsPath
		? new ObservationOutbox({
				path: obsPath,
				hubId: process.env.BUCKLE_HUB_ID,
			})
		: undefined;
	// W461 stage 3: the read model — ingest the outbox into the projected
	// lane/route tables on a short poll (the board reads the same db).
	let projection: LaneProjection | undefined;
	if (obsPath) {
		projection = new LaneProjection(
			process.env.BUCKLE_OBSERVATIONS_DB ?? `${obsPath}.db`,
		);
		const tailer = new OutboxTailer(projection, obsPath);
		const ingest = setInterval(() => {
			// W2173.7: a poll failure is logged, never silently swallowed — a
			// dead observation tailer must be visible at error level.
			void tailer.poll().catch((e: unknown) => {
				serverLog.error(
					`buckle.observation_poll_failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			});
		}, 2000);
		ingest.unref();
	}
	return {
		router,
		policy,
		ledger,
		admission,
		aids,
		preseeder,
		aidsPolicy,
		expander,
		repoPolicy: repoPolicy.rows,
		accountPolicy: accountPolicy.doc,
		sm,
		pool,
		decide,
		table,
		federation,
		affinity,
		laneCache,
		prefixLedger,
		diet,
		observations,
		ingressBodyTimeoutMs: opts.ingressBodyTimeoutMs,
		hubId: process.env.BUCKLE_HUB_ID ?? "local",
	};
}

/** Start buckle on the shadow port. Returns the Bun server for tests, with
 *  `.gov` attached (W154: tests and W160 seed/read the CR queue through it). */
export function startServer(opts: ServerOpts = {}): ReturnType<
	typeof Bun.serve
> & {
	gov: ReturnType<typeof createGovernance>;
	connectEgress?: ConnectEgress;
} {
	const port = resolvePort(opts.port);
	const deps = buildDeps(opts, port);
	const app = createApp(deps);
	// W141 governance gate: enforced unless BUCKLE_AUTH=off (empty string
	// counts as unset — the W147 empty-env lesson).
	const authEnv = process.env.BUCKLE_AUTH ?? "";
	const authOn = authEnv.length > 0 ? authEnv !== "off" : true;
	const gov = createGovernance(
		{ ledger: deps.ledger, sm: deps.sm },
		{
			dbPath: opts.dbPath ?? defaultDbPath(),
			rootKey: opts.auth?.rootKey,
			// W372: env-driven OIDC gate (stack.json auth.oidc materialized by
			// hubctl) — programmatic opts win, env next, base posture last.
			jwt: opts.auth?.jwt ?? oidcGateOptsFromEnv() ?? undefined,
			federation: deps.federation,
			slots: opts.auth?.slots,
			ingressBodyTimeoutMs: opts.ingressBodyTimeoutMs,
			adaptation: opts.auth?.adaptation,
			metrics: opts.auth?.metrics,
			providerAdmission: () => deps.router.providerAdmissionSnapshot(),
		},
	);
	const gated = authOn ? gov.gate(app.fetch) : app.fetch;
	const inner = deps.sm.fetch(gated);
	// W162.1 hub bind: a spoke (the common case) never leaves opts.hostname/
	// BUCKLE_BIND unset and stays 127.0.0.1 — zero change in behavior. A hub
	// deployment (owner directive 2026-10-03: real multi-machine reach, not
	// a cosmetic label) opts in explicitly. Non-loopback with the gate off
	// would serve ungated LLM routing to the whole LAN/WAN — refuse to boot
	// rather than silently expose it (same "never silent" law as 4100).
	const hostname = opts.hostname ?? process.env.BUCKLE_BIND ?? "127.0.0.1";
	if (hostname !== "127.0.0.1" && !authOn) {
		throw problemOf("forbidden", {
			code: "buckle.bind_refused",
			why:
				`BUCKLE_BIND=${hostname} refused — a non-loopback bind requires the ` +
				"governance gate (BUCKLE_AUTH=on, the default); set it or stay on " +
				"127.0.0.1. /status and /health remain public either way.",
		});
	}
	const server = Bun.serve({
		hostname,
		port,
		// W199.2: the explicit body cap — over-cap requests get Bun's 413 and
		// never reach the governance gate, the ledger or the pool.
		maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
		// W1106 (owner directive 2026-10-21): Bun's HTTP idle timer is OFF
		// for every request — a fixed connection cutoff cannot arbitrate
		// quiet LLM streams (Bun ignores outgoing bytes; the ~120s fleet
		// outage). Buckle's own guards (wire.ts upstream idle/total,
		// first-byte budget) are the ONLY deadlines.
		idleTimeout: BUN_IDLE_TIMEOUT,
		fetch: inner,
	});
	// W1260.2: the authenticated CONNECT egress (opaque AI TLS relay). Inert
	// unless policy enables it AND BUCKLE_CONNECT_TOKEN is set AND allow is
	// non-empty; attaches when live so tests can stop it.
	const connectEgress = startConnectEgress(deps.policy, port, { sm: deps.sm });
	return Object.assign(server, { gov, connectEgress }) as ReturnType<
		typeof Bun.serve
	> & {
		gov: ReturnType<typeof createGovernance>;
		connectEgress?: ConnectEgress;
	};
}

/** W235 boot: overlay load (fail-closed) BEFORE the server starts; unset =
 *  solo posture; what loaded is logged (log-at-startup law). */
export async function boot(): Promise<
	ReturnType<typeof Bun.serve> & {
		gov: ReturnType<typeof createGovernance>;
		connectEgress?: ConnectEgress;
	}
> {
	const port = resolvePort();
	// break-glass root credential (2026-10-05): hub deploys run the governance
	// gate ON; without a root key NOTHING can authenticate or mint — every
	// request 401s "unknown credential type" (the fleet-wide lane death).
	// BUCKLE_ROOT_KEY from runtime env seeds the bootstrap principal; mint
	// real bksk_ keys via /v1/admin/keys and retire the root when done.
	const rootKey = process.env.BUCKLE_ROOT_KEY;
	const overlay = await loadOverlay({
		dir: process.env.KLH_OVERLAY_DIR,
		expectSha256: process.env.KLH_OVERLAY_SHA256,
	});
	if (!overlay.ok && overlay.why !== "unset")
		throw problemOf("forbidden", {
			code: "buckle.overlay_refused",
			why: `overlay refused: ${overlay.why}`,
		});
	const adaptation = overlay.ok
		? overlayModuleAdaptation(overlay.module)
		: undefined;
	// W688.3: the gov factories the overlay module supplies — boot() hands
	// them to startServer auth opts (provider-less solo unchanged: absent
	// export = no factories = honest 501s on the federation routes).
	const gov = overlay.ok ? overlayModuleGovSeam(overlay.module) : undefined;
	if (overlay.ok)
		serverLog.info(
			`overlay ${overlay.manifest.name} protocol ${overlay.manifest.protocol} ` +
				`loaded (entry sha256 ${overlay.manifest.sha256.slice(0, 12)}…)` +
				(gov ? ` gov seam: ${Object.keys(gov).join(", ")}` : " gov seam: none"),
		);
	return startServer({
		port,
		...(rootKey || adaptation || gov
			? {
					auth: {
						...(rootKey ? { rootKey } : {}),
						...(adaptation ? { adaptation } : {}),
						...(gov ?? {}),
					},
				}
			: {}),
	});
}

/** Entry: bind the shadow port, log the guard. W2173.7: a startup fatal is
 *  never silent — the boot rejection logs the stable code at error level and
 *  exits 1, so launchd KeepAlive sees a real failure instead of a dead boot. */
export function main(): void {
	void boot()
		.then((server) =>
			serverLog.info(
				`shadow router on http://${server.hostname}:${server.port}` +
					` (4100 refused by design, root ${process.env.BUCKLE_ROOT_KEY ? "keyed" : "unset"})`,
			),
		)
		.catch((e: unknown) => {
			const why =
				e instanceof HttpProblem
					? `${e.code}: ${e.message}`
					: e instanceof Error
						? e.message
						: String(e);
			serverLog.error(`buckle.boot_failed: ${why}`);
			process.exit(1);
		});
}

if (import.meta.main) main();
