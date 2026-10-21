#!/usr/bin/env bun
// Read-only route gate. The graph is built from the same machine config the
// gateways render; no route, key, service, or work item is changed here.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { SPECIALISTS } from "../../belt/bin/registry.ts";
import { STACK_PATH } from "../hooks/lib/stack-config.ts";
import { runForcedFailoverDrill } from "../../buckle/src/forced-failover-drill.ts";
import {
	loadGatewayPolicy,
	type GatewayPolicy,
} from "../../buckle/src/policy.ts";
import {
	validateRouteLadders,
	type RouteLadderFinding,
	type RouteLadderInputs,
} from "../../buckle/src/route-ladder-validator.ts";
import {
	loadUpstreams,
	type Deployment,
	type UpstreamPool,
} from "../../buckle/src/upstreams.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: {};
const string = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

function poolFrom(value: unknown): UpstreamPool {
	const groups = record(record(value).groups);
	return {
		groups: () =>
			Object.keys(groups).filter((name) => Array.isArray(groups[name])),
		deployments: (name) => {
			const rows = groups[name];
			return Array.isArray(rows)
				? rows.map((item) => ({ ...record(item), group: name }) as Deployment)
				: [];
		},
	};
}

function activePool(pool: UpstreamPool): UpstreamPool {
	const names = pool
		.groups()
		.filter((name) => pool.deployments(name).length > 0);
	return {
		groups: () => names,
		deployments: (name) => pool.deployments(name),
	};
}

function origin(raw: string): string {
	return new URL(raw).origin;
}

function hubOrigin(name: string, hub: RecordValue): string {
	const explicit = string(hub.url);
	if (explicit) return origin(explicit);
	const host = string(hub.host);
	const port = Number(hub.buckle_port);
	if (!host || !Number.isSafeInteger(port) || port < 1)
		throw new Error(`hub ${name} has no routable Buckle origin`);
	return origin(`http://${host}:${port}`);
}

export interface RoutePreflightSources {
	stack: unknown;
	localPool: UpstreamPool;
	policy: GatewayPolicy;
	litellm: unknown;
	deadlineMs?: number;
}

export function routeInputs(source: RoutePreflightSources): RouteLadderInputs {
	const stack = record(source.stack);
	const hubs = record(stack.hubs);
	if (Object.keys(hubs).length === 0)
		throw new Error(
			"stack.yaml has no hubs; route ownership cannot be checked",
		);
	const preflight = record(stack.route_preflight);
	const declared = preflight.terminal_origins;
	if (declared !== undefined && !Array.isArray(declared))
		throw new Error("route_preflight.terminal_origins must be an array");
	const terminals = (declared ?? []) as unknown[];
	if (terminals.some((item) => !string(item)))
		throw new Error("route_preflight.terminal_origins must contain URLs");
	const buckles: RouteLadderInputs["buckles"] = [
		{
			id: "local",
			origins: ["http://127.0.0.1:4101"],
			pool: activePool(source.localPool),
			policy: source.policy,
		},
	];
	const beltModels: NonNullable<RouteLadderInputs["belts"]> = [];
	for (const [name, raw] of Object.entries(hubs)) {
		const hub = record(raw);
		buckles.push({
			id: name,
			origins: [hubOrigin(name, hub)],
			pool: activePool(poolFrom(hub.upstreams)),
			policy: {},
		});
		if (hub.belt_model !== undefined) {
			const model = record(hub.belt_model);
			const port = Number(model.port);
			const upstream = string(model.upstream);
			if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !upstream)
				throw new Error(`hub ${name} has an invalid belt_model route`);
			const outside = new URL(hubOrigin(name, hub));
			outside.port = String(port);
			beltModels.push({
				id: `${name}-model`,
				origins: [outside.origin, `http://127.0.0.1:${port}`],
				upstream,
			});
		}
	}
	const specialistOrigins = SPECIALISTS.map(
		(item) => `http://127.0.0.1:${item.port}`,
	);
	const escalationUrl = string(process.env.BELT_ESCALATE_URL);
	const escalationModel = string(process.env.BELT_ESCALATE_MODEL);
	return {
		buckles,
		litellms: [
			{
				id: "local",
				origins: ["http://127.0.0.1:4100", "http://host.docker.internal:4100"],
				config: source.litellm,
			},
		],
		belts: [
			{
				id: "local",
				origins: ["http://127.0.0.1:4000"],
				...(escalationUrl && escalationModel
					? { escalation: { url: escalationUrl, model: escalationModel } }
					: {}),
			},
			...beltModels,
		],
		terminalOrigins: [...specialistOrigins, ...(terminals as string[])],
		requestDeadlineMs: source.deadlineMs,
	};
}

async function reachable(raw: string, timeoutMs: number): Promise<boolean> {
	try {
		const response = await fetch(new URL("/status", raw), {
			method: "GET",
			signal: AbortSignal.timeout(timeoutMs),
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

export interface RoutePreflightResult {
	ok: boolean;
	mode: "live" | "static";
	checkedNodes: number;
	findings: RouteLadderFinding[];
	probes: Array<{ origin: string; reachable: boolean }>;
	drills: Array<{
		group: string;
		fallback: string;
		failureStatus: number;
		ok: boolean;
	}>;
}

export async function checkRoutePreflight(
	source: RoutePreflightSources,
	probe = reachable,
	options: { probeHubs?: boolean } = {},
): Promise<RoutePreflightResult> {
	const inputs = routeInputs(source);
	const graph = validateRouteLadders(inputs);
	const origins = new Set(
		inputs.buckles.flatMap((buckle) => buckle.origins).slice(1),
	);
	const probes =
		options.probeHubs === false
			? []
			: await Promise.all(
					[...origins].map(async (url) => ({
						origin: url,
						reachable: await probe(url, 3000),
					})),
				);
	const drills: RoutePreflightResult["drills"] = [];
	const local = inputs.buckles[0];
	for (const [group, fallbacks] of Object.entries(
		local.policy.fallbacks ?? {},
	)) {
		const fallback = fallbacks.find(
			(name) => local.pool.deployments(name).length > 0,
		);
		if (!fallback || local.pool.deployments(group).length === 0) continue;
		for (const failureStatus of [429, 503] as const) {
			const report = await runForcedFailoverDrill({
				policy: local.policy,
				pool: local.pool,
				group,
				fallback,
				failureStatus,
				maxAttempts: 32,
				maxWallMs: 3000,
			});
			drills.push({ group, fallback, failureStatus, ok: report.ok });
		}
		break;
	}
	return {
		mode: options.probeHubs === false ? "static" : "live",
		ok:
			graph.errors.length === 0 &&
			probes.every((item) => item.reachable) &&
			drills.length > 0 &&
			drills.every((item) => item.ok),
		checkedNodes: graph.checkedNodes,
		findings: graph.errors,
		probes,
		drills,
	};
}

export async function machineRoutePreflight(
	options: { probeHubs?: boolean } = {},
): Promise<RoutePreflightResult> {
	const home = homedir();
	const stackPath = STACK_PATH();
	const llm = join(home, ".claude/local-llm");
	const upstreamPath =
		process.env.BUCKLE_UPSTREAMS ?? join(llm, "upstreams.yaml");
	const litePath = process.env.LITELLM_CONFIG ?? join(llm, "litellm.yaml");
	for (const path of [stackPath, upstreamPath, litePath])
		if (!existsSync(path))
			throw new Error(`required route config absent: ${path}`);
	process.env.BUCKLE_UPSTREAMS = upstreamPath;
	const stack = YAML.parse(readFileSync(stackPath, "utf8"));
	const litellm = YAML.parse(readFileSync(litePath, "utf8"));
	const deadlineMs = Number(process.env.SUSPENDERS_LANE_DEADLINE_MS || 900000);
	return checkRoutePreflight(
		{
			stack,
			localPool: loadUpstreams(),
			policy: loadGatewayPolicy(),
			litellm,
			deadlineMs,
		},
		reachable,
		options,
	);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"usage: route-preflight [--static] [--help]\n  --static  validate graph and synthetic failover without probing live hubs (for first hub activation)",
		);
		process.exit(0);
	}
	if (args.some((arg) => arg !== "--static")) {
		console.error("route-preflight: unknown option; use --help");
		process.exit(2);
	}
	try {
		const result = await machineRoutePreflight({
			probeHubs: !args.includes("--static"),
		});
		console.log(JSON.stringify(result));
		process.exitCode = result.ok ? 0 : 1;
	} catch (error) {
		console.error(
			`route-preflight: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
