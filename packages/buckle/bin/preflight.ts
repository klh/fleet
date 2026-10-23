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
import { loadGatewayPolicy, parsePolicy } from "../src/policy.ts";
import type { GatewayPolicy } from "../src/policy.ts";
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
// The hub's REAL policy is the COMMITTED routing policy — hubctl renders
// exactly this file onto every hub (pushGatewayPolicy) — with the hub's
// buckle_gateway override shallow-spread over it (renderHubPolicy's merge).
// This device's live policy is the Mac's posture, never a hub's.
let committedPolicy: GatewayPolicy;
try {
	committedPolicy = parsePolicy(
		readFileSync(
			new URL("../routing-policy.yaml", import.meta.url).pathname,
			"utf8",
		),
	);
} catch (e) {
	die(
		`committed routing policy failed to load: ${e instanceof Error ? e.message : e}`,
	);
}

// ── the stack: hub origins + the inventories they resolve ──────────────────
// The real HubProfile shape (suspenders hooks/lib/stack-config.ts):
// zai_litellm_url + the hub's REAL upstream ladder live under
// hub.upstreams, not top level.
interface StackHub {
	url?: string;
	host?: string;
	buckle_port?: number;
	buckle_gateway?: GatewayPolicy;
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

// The LOCAL engine config is optional machine state: absent → the ladder is
// validated engine-less (rows pointing at :4100 then fail as unmapped).
// Hub-side engines (zai_litellm_url) are NEVER credited this snapshot's
// config — the Mac holds no hub model_list — so each registers unverified
// and its rows report unverified_engine (never silently green).
// The belt swarm's pinned specialist ports (belt bin/router-shim.ts
// registry rows) — the LOCAL pool's AND the local engine's terminals,
// resolved on this device. Hub inventories never vouch for them (review
// #55637).
const swarmPorts = [8901, 8902, 8903, 8906, 8907, 8912, 8913];
let litellms: LiteLlmRouteConfig[] = [];
if (existsSync(litellmPath)) {
	try {
		litellms = [
			{
				id: "engine",
				origins: ["http://127.0.0.1:4100"],
				// W1094: the engine's own model_list api_bases land on the
				// swarm specialists it fronts — this engine's rows resolve
				// loopback onto THIS device's pinned set.
				terminals: swarmPorts.map((port) => `http://127.0.0.1:${port}`),
				config: Bun.YAML.parse(readFileSync(litellmPath, "utf8")),
			},
		];
	} catch (e) {
		die(
			`litellm config failed to parse: ${e instanceof Error ? e.message : e}`,
		);
	}
}
for (const [name, hub] of Object.entries(hubs)) {
	const url = hub.upstreams?.zai_litellm_url;
	if (typeof url !== "string") continue;
	litellms.push({ id: `engine:${name}`, origins: [url], unverified: true });
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
		terminals: swarmPorts.map((port) => `http://127.0.0.1:${port}`),
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
		// A hub pool's terminals are ONLY the loopback leaves that hub's own
		// inventory declares — a global set would let one device's inventory
		// vouch for another's port (trace b73f8a2d, review #55637).
		const ownTerminals = [...Object.values(rows)]
			.flat()
			.map((row) => row?.url)
			.filter(
				(url): url is string =>
					typeof url === "string" &&
					/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(url),
			);
		// The hub's REAL ladder policy is the committed routing policy with
		// the hub's buckle_gateway override spread over it — renderHubPolicy's
		// merge, mirrored.
		const hubPolicy: GatewayPolicy = {
			...committedPolicy,
			...(hub.buckle_gateway ?? {}),
		};
		if (groups.length === 0)
			return [
				{
					id: origin,
					origins: [origin],
					policy: hubPolicy,
					pool: { groups: () => [], deployments: () => [] },
					terminals: ownTerminals,
				},
			];
		return [
			{
				id: origin,
				origins: [origin],
				policy: hubPolicy,
				pool: {
					groups: () => groups,
					deployments: (group: string) =>
						(rows[group] ?? []).map((row) => ({
							...row,
							group,
							dialect: "openai" as const,
						})),
				},
				terminals: ownTerminals,
			},
		];
	}),
];

const { errors, checkedNodes } = validateRouteLadders({
	buckles,
	litellms,
	belts,
	requestDeadlineMs:
		deadline !== undefined && Number.isFinite(deadline) && deadline > 0
			? deadline
			: undefined,
});

// W1094 unverified face: rows onto engines this snapshot holds no config
// for are REPORTED, never silently green — but non-gating (the proof lives
// on another device). Gating findings fail the run; unverified ones do not.
const unverified = errors.filter((e) => e.code.startsWith("unverified_"));
const gating = errors.filter((e) => !e.code.startsWith("unverified_"));

if (has("json"))
	console.log(
		JSON.stringify(
			{ ok: gating.length === 0, checkedNodes, errors: gating, unverified },
			null,
			2,
		),
	);
else {
	console.log(
		`preflight: ${checkedNodes} route nodes checked (${baseFile}${hubOrigins.length ? `, ${hubOrigins.length} hub(s)` : ""})`,
	);
	for (const e of gating)
		console.log(`FAIL ${e.code} [${e.layer}] ${e.path}: ${e.detail}`);
	for (const e of unverified)
		console.log(`UNVERIFIED ${e.code} [${e.layer}] ${e.path}: ${e.detail}`);
	if (gating.length === 0)
		console.log(
			unverified.length === 0
				? "preflight: clean"
				: `preflight: clean (${unverified.length} unverified — proof lives off this device)`,
		);
}
process.exit(gating.length === 0 ? 0 : 1);
