// bin/preflight.ts — W1094 release preflight: validate the LIVE routing
// ladder config (upstream pool + gateway policy + LiteLLM engine config)
// through src/route-ladder-validator.ts before a deploy or activation.
// Config-over-code: reads the same resolution chains the server does
// (BUCKLE_UPSTREAMS / BUCKLE_POLICY / LITELLM_CONFIG override the machine
// defaults). Findings name groups, origins and codes — never key material:
// the validator's vocabulary has no secret surface (URL origins only).
//
//	bun bin/preflight.ts [--upstreams PATH] [--policy PATH]
//	                    [--litellm-config PATH] [--json] [--deadline-ms N]
//
// Exit: 0 clean · 1 findings · 2 config load failure.
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
const litellmPath =
	arg("litellm-config") ??
	process.env.LITELLM_CONFIG ??
	`${home}/.claude/local-llm/litellm.yaml`;

const die = (message: string): never => {
	console.error(`preflight: ${message}`);
	process.exit(2);
};

let pool: ReturnType<typeof loadUpstreams>;
try {
	pool = loadUpstreams(arg("upstreams") ?? undefined);
} catch (e) {
	die(`upstreams failed to load: ${e instanceof Error ? e.message : e}`);
}
let policy: ReturnType<typeof loadGatewayPolicy>;
try {
	policy = loadGatewayPolicy(arg("policy") ?? undefined);
} catch (e) {
	die(`policy failed to load: ${e instanceof Error ? e.message : e}`);
}

// The engine config is optional machine state: absent → the ladder is
// validated engine-less (rows pointing at :4100 then fail as unmapped).
let litellms: LiteLlmRouteConfig[] = [];
if (existsSync(litellmPath)) {
	try {
		litellms = [
			{
				id: "engine",
				origins: ["http://127.0.0.1:4100"],
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

if (has("json"))
	console.log(
		JSON.stringify({ ok: errors.length === 0, checkedNodes, errors }, null, 2),
	);
else {
	console.log(`preflight: ${checkedNodes} route nodes checked`);
	if (errors.length === 0) console.log("preflight: clean");
	else
		for (const e of errors)
			console.log(`FAIL ${e.code} [${e.layer}] ${e.path}: ${e.detail}`);
}
process.exit(errors.length === 0 ? 0 : 1);
