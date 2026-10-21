// bin/preflight.ts — W1094 release preflight: validate the LIVE routing
// ladder config (upstream pool + gateway policy + LiteLLM engine config)
// through src/route-ladder-validator.ts before a deploy or activation.
//
// Live-config resolution (review #55582): the DEFAULT invocation reads the
// machine runtime upstreams (~/.claude/local-llm/upstreams.yaml, the file
// the spoke actually serves) with BUCKLE_UPSTREAMS still merging over it —
// exactly the server's chain. A missing live file is a FAILURE (exit 2),
// never a silent fallback to the loopback-only committed rows; pass
// --upstreams explicitly or --allow-committed for dev/test posture. Hub
// origins come from the ONE stack config (~/.config/klh/stack.yaml,
// KLH_STACK overrides): every configured hub registers as a buckle service,
// and the belt swarm's pinned specialist ports are terminals so ladder rows
// onto :890x etc. are routable, not unmapped noise.
// Findings name groups, origins and codes — never key material.
//
//	bun bin/preflight.ts [--upstreams PATH] [--policy PATH]
//	                    [--litellm-config PATH] [--stack PATH] [--json]
//	                    [--deadline-ms N] [--allow-committed]
//
// Exit: 0 clean · 1 findings · 2 live config unresolvable.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
	type BeltRouteConfig,
	type BuckleRouteConfig,
	type LiteLlmRouteConfig,
	validateRouteLadders,
} from "../src/route-ladder-validator.ts";
import { loadGatewayPolicy } from "../src/policy.ts";
import { loadUpstreams } from "../src/upstreams.ts";

const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const home = process.env.HOME ?? homedir();
const machineUpstreams = `${home}/.claude/local-llm/upstreams.yaml`;
const litellmPath =
	arg("litellm-config") ??
	process.env.LITELLM_CONFIG ??
	`${home}/.claude/local-llm/litellm.yaml`;
const stackPath =
	arg("stack") ?? process.env.KLH_STACK ?? `${home}/.config/klh/stack.yaml`;

const die = (message: string): never => {
	console.error(`preflight: ${message}`);
	process.exit(2);
};

// ── upstream pool: the live machine file is the default base ───────────────
const explicitUpstreams = arg("upstreams");
const allowCommitted = has("allow-committed");
let baseFile: string;
if (explicitUpstreams !== null) baseFile = explicitUpstreams;
else if (existsSync(machineUpstreams)) baseFile = machineUpstreams;
else if (allowCommitted)
	baseFile = new URL("../upstreams.yaml", import.meta.url).pathname;
else
	die(
		`live upstreams not found at ${machineUpstreams} — pass --upstreams PATH or --allow-committed`,
	);
let pool: ReturnType<typeof loadUpstreams>;
try {
	pool = loadUpstreams(baseFile);
} catch (e) {
	die(
		`upstreams ${baseFile} failed to load: ${e instanceof Error ? e.message : e}`,
	);
}
let policy: ReturnType<typeof loadGatewayPolicy>;
try {
	policy = loadGatewayPolicy(arg("policy") ?? undefined);
} catch (e) {
	die(`policy failed to load: ${e instanceof Error ? e.message : e}`);
}

// ── the stack: hub origins + the inventories they resolve ──────────────────
// The real HubProfile shape (suspenders hooks/lib/stack-config.ts):
// zai_litellm_url + the hub's REAL upstream ladder live under
// hub.upstreams, not top level.
interface StackHub {
	url?: string;
	host?: string;
	buckle_port?: number;
	upstreams?: {
		groups?: Record<string, Array<Record<string, unknown>>>;
		zai_litellm_url?: string;
	};
}
let hubs: Record<string, StackHub> = {};
if (existsSync(stackPath)) {
	try {
		const doc = Bun.YAML.parse(readFileSync(stackPath, "utf8")) as {
			hubs?: Record<string, StackHub>;
		} | null;
		hubs = doc?.hubs ?? {};
	} catch {
		die(`stack config ${stackPath} failed to parse`);
	}
}
const hubOrigin = (hub: StackHub): string | null => {
	if (hub.url) return hub.url;
	if (hub.host && hub.buckle_port)
		return `http://${hub.host.replace(/^[^@]+@/, "")}:${hub.buckle_port}`;
	return null;
};
const hubOrigins = [...Object.values(hubs)]
	.map(hubOrigin)
	.filter((origin): origin is string => origin !== null);

// The engine config is optional machine state: absent → the ladder is
// validated engine-less (rows pointing at :4100 then fail as unmapped).
let litellms: LiteLlmRouteConfig[] = [];
if (existsSync(litellmPath)) {
	try {
		litellms = [
			{
				id: "engine",
				origins: [
					"http://127.0.0.1:4100",
					...[...Object.values(hubs)]
						.map((hub) => hub.upstreams?.zai_litellm_url)
						.filter((url): url is string => typeof url === "string"),
				],
				config: Bun.YAML.parse(readFileSync(litellmPath, "utf8")),
			},
		];
	} catch (e) {
		die(
			`litellm config failed to parse: ${e instanceof Error ? e.message : e}`,
		);
	}
}

const deadlineRaw = arg("deadline-ms");
const deadline = deadlineRaw === null ? undefined : Number(deadlineRaw);
const beltOrigin = process.env.BELT_ESCALATE_URL ?? "http://127.0.0.1:4000";
const belts: BeltRouteConfig[] = [
	{
		id: "router",
		origins: [beltOrigin],
	},
];
const buckles: BuckleRouteConfig[] = [
	{
		id: "local",
		origins: [process.env.BUCKLE_ORIGIN ?? "http://127.0.0.1:4101"],
		policy,
		pool,
	},
	// Every configured hub is a known buckle service. When the hub profile
	// carries its REAL upstream ladder (hub.upstreams.groups), that
	// inventory resolves inter-buckle group demand locally; without it the
	// snapshot is opaque — the edge keeps its cycle checks and the hub's own
	// preflight run owns the membership proof.
	...Object.values(hubs).flatMap((hub) => {
		const origin = hubOrigin(hub);
		if (origin === null) return [];
		const rows = hub.upstreams?.groups ?? {};
		const groups = Object.keys(rows);
		if (groups.length === 0)
			return [
				{
					id: origin,
					origins: [origin],
					policy,
					pool: { groups: () => [], deployments: () => [] },
					opaque: true,
				},
			];
		return [
			{
				id: origin,
				origins: [origin],
				// The hub's own ladder policy lives on the hub device; this
				// snapshot checks membership/deadline, never its fallbacks.
				policy: { ...policy, fallbacks: {} },
				pool: {
					groups: () => groups,
					deployments: (group: string) =>
						(rows[group] ?? []).map((row) => ({
							...row,
							group,
							dialect: "openai" as const,
						})),
				},
			},
		];
	}),
];

// The belt swarm's pinned specialist ports (belt bin/router-shim.ts
// registry rows): local ladder targets onto them are terminals, never
// unmapped findings. Hub-inventory rows referencing hub-loopback services
// (the hub's own ollama/swarm) are terminals too — declared by the hub's
// serving registry, resolvable only from the hub. Scope note: a LOCAL row
// onto one of those hub-loopback origins is exempted as well; the local
// machine carries no such port today.
const swarmPorts = [8901, 8902, 8903, 8906, 8907, 8912, 8913];
const hubLoopback = [...Object.values(hubs)].flatMap((hub) =>
	[...Object.values(hub.upstreams?.groups ?? {})]
		.flat()
		.map((row) => row?.url)
		.filter(
			(url): url is string =>
				typeof url === "string" &&
				/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(url),
		),
);
const terminalOrigins = [
	...swarmPorts.map((port) => `http://127.0.0.1:${port}`),
	...hubLoopback,
];

const { errors, checkedNodes } = validateRouteLadders({
	buckles,
	litellms,
	belts,
	terminalOrigins,
	requestDeadlineMs:
		deadline !== undefined && Number.isFinite(deadline) && deadline > 0
			? deadline
			: undefined,
});

if (has("json"))
	console.log(
		JSON.stringify({ ok: errors.length === 0, checkedNodes, errors }, null, 2),
	);
else {
	console.log(
		`preflight: ${checkedNodes} route nodes checked (${baseFile}${hubOrigins.length ? `, ${hubOrigins.length} hub(s)` : ""})`,
	);
	if (errors.length === 0) console.log("preflight: clean");
	else
		for (const e of errors)
			console.log(`FAIL ${e.code} [${e.layer}] ${e.path}: ${e.detail}`);
}
process.exit(errors.length === 0 ? 0 : 1);
