// bin/gateway-config.ts — generate the LiteLLM gateway config from belt's
// registry (local tiers: bin/registry.ts via registry-emit) + remotes.json
// (remote tiers). Output is PRIVATE:
// ~/.claude/local-llm/litellm.yaml (mode 600 — carries the zai key reference,
// resolved at runtime via os.environ/Z_AI_API_KEY, never inline).
import {
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { chatGptSubscriptionRows } from "./chatgpt-subscription-rows.ts";
import { openRouterFreeRows } from "./openrouter-free-rows.ts";
import { chatEntries, ROUTER } from "./registry.ts";
import { litellmRows } from "./registry-emit.ts";
import { buildRemoteEntries } from "./remotes-validate.ts";
import {
	emitClassTiers,
	emitLiteLlmSettings,
	emitRouterSettings,
	loadDirectTiers,
	loadGatewayPolicy,
} from "./router-policy.ts";
import {
	readZaiSnapshot,
	zaiCatalogFile,
	zaiLiteLlmRows,
} from "./zai-catalog-rows.ts";

const HOME = process.env.HOME ?? homedir();
const REMOTES_PATH = `${HOME}/.claude/local-llm/remotes.json`;
const OPENROUTER_FREE_CATALOG =
	process.env.OPENROUTER_FREE_CATALOG ??
	`${HOME}/.claude/local-llm/openrouter-free.json`;

// W192: remotes.json is parsed but NEVER trusted — grammar validation and
// entry building live in remotes-validate.ts. Unparseable config aborts the
// regen loudly (the last good litellm.yaml stays); per-entry validation
// failures are skipped + warned on stderr below.
let remotesRaw: unknown;
try {
	remotesRaw = JSON.parse(readFileSync(REMOTES_PATH, "utf8"));
} catch (err) {
	console.error(
		`gateway-config: ${REMOTES_PATH} unreadable or invalid JSON — not writing litellm.yaml (${err instanceof Error ? err.message : String(err)})`,
	);
	process.exit(1);
}

// W271: local tiers are GENERATED from the registry (bin/registry.ts) — the
// one place an LLM is registered. Chat-class rows only (reranker / embed /
// classify speak other APIs; the :4000 shim is Anthropic INGRESS for Claude).
// A best-effort live probe warns on registry↔served drift, never decides.
const locals = chatEntries();
const discovered: { port: number; id: string }[] = [];
for (const e of locals) {
	try {
		const r = (await fetch(`http://127.0.0.1:${e.port}/v1/models`, {
			signal: AbortSignal.timeout(2000),
		}).then((x) => x.json())) as { data?: { id?: string }[] };
		const id = r.data?.[0]?.id;
		if (id) discovered.push({ port: e.port, id });
		if (id && id !== e.model)
			console.error(
				`gateway-config: drift :${e.port} serves ${id}, registry says ${e.model}`,
			);
	} catch {
		console.error(
			`gateway-config: :${e.port} not answering (registry row kept)`,
		);
	}
}

const entries: string[] = litellmRows(locals);
// Remote tiers: validated + built by remotes-validate (W192) — invalid
// machines/endpoints are skipped + warned on stderr, never interpolated.
const remotesBuilt = buildRemoteEntries(remotesRaw);
for (const s of remotesBuilt.skipped)
	console.error(`gateway-config: skipped ${s.ref}: ${s.why}`);
entries.push(...remotesBuilt.entries);
// Extend the user's explicit remote routes from the authenticated Z.ai
// account catalog. Bad or stale data aborts regeneration before any write.
const zaiCatalogPath = zaiCatalogFile(HOME, process.env);
if (existsSync(zaiCatalogPath)) {
	const template = remotesBuilt.entries.find((entry) =>
		/^[ \t]*model: zai\/glm-/m.test(entry),
	);
	if (!template)
		throw new Error(
			"Z.ai catalog needs a validated zai remote in remotes.json",
		);
	const names = new Set(
		entries
			.flatMap((entry) => [...entry.matchAll(/^\s*- model_name: ([^\s]+)$/gm)])
			.map((match) => match[1]),
	);
	entries.push(
		...zaiLiteLlmRows(readZaiSnapshot(zaiCatalogPath), template, names),
	);
}
// An inference key is the activation gate. A management key is not usable
// here; the LiteLLM supervisor injects only OPENROUTER_API_KEY.
const openRouterKeyPresent = Boolean(
	process.env.OPENROUTER_API_KEY?.trim() ||
		(() => {
			try {
				const key = statSync(`${HOME}/.claude/local-llm/openrouter.key`);
				return key.isFile() && (key.mode & 0o777) === 0o600 && key.size > 0;
			} catch {
				return false;
			}
		})(),
);
if (openRouterKeyPresent)
	entries.push(...openRouterFreeRows(OPENROUTER_FREE_CATALOG));

// An operator-owned file opts in models served through a separate ChatGPT
// subscription login. Its absence leaves the provider out of the catalog.
const chatGptModelsPath = `${HOME}/.claude/local-llm/chatgpt-models.json`;
if (existsSync(chatGptModelsPath)) {
	const mode = statSync(chatGptModelsPath).mode & 0o777;
	if (mode !== 0o600)
		throw new Error(`${chatGptModelsPath} must have mode 0600`);
	const config = JSON.parse(readFileSync(chatGptModelsPath, "utf8")) as unknown;
	entries.push(...chatGptSubscriptionRows(config));
}

// (openai-dialect draft above is superseded by fullYaml — kept variables
// merged there; this block intentionally removed)

// Anthropic-dialect upstreams — the Claude-Code drop-in path. model_name
// MUST equal the id Claude sends verbatim ([1m] included). z.ai anthropic
// endpoint is keyed today; api.anthropic.com activates when ANTHROPIC_API_KEY
// lands. Appended AFTER the yaml build above? No — rebuild with both lists:
const anth = [
	// [1m] never hits the wire — Claude Code strips it client-side as a
	// context hint; the wire id is bare (proven: [1m] 1211s on z.ai directly,
	// bare id works). Same model_name as the openai-dialect entries = one
	// group, two dialects; LiteLLM load-balances/fallbacks across them.
	{
		name: "glm-5.3-flash",
		model: "anthropic/glm-5.3-flash",
		base: "https://api.z.ai/api/anthropic",
		key: "os.environ/Z_AI_API_KEY",
	},
	{
		name: "glm-5.3",
		model: "anthropic/glm-5.3",
		base: "https://api.z.ai/api/anthropic",
		key: "os.environ/Z_AI_API_KEY",
	},
	{
		name: "glm-5.2",
		model: "anthropic/glm-5.2",
		base: "https://api.z.ai/api/anthropic",
		key: "os.environ/Z_AI_API_KEY",
	},
	{
		name: "claude-sonnet-5",
		model: "anthropic/claude-sonnet-5",
		base: "https://api.anthropic.com",
		key: "os.environ/ANTHROPIC_API_KEY",
	},
	{
		name: "claude-haiku-4-5",
		model: "anthropic/claude-haiku-4-5",
		base: "https://api.anthropic.com",
		key: "os.environ/ANTHROPIC_API_KEY",
	},
	{
		// Degradation tier: the local swarm ingress (:4000). LiteLLM POSTs
		// Anthropic-shape requests to any base — the shim accepts glm ids and
		// routes by complexity (audit row: anthropic/<name> + api_base).
		name: ROUTER.gatewayAlias,
		model: `anthropic/${ROUTER.gatewayAlias}`,
		base: "http://127.0.0.1:4000",
		key: "dummy",
	},
	{
		// Dormant until OPENAI_API_KEY lands; ladder falls through a group
		// whose upstream fails, so the empty key just skips this tier.
		name: "gpt-5.2",
		model: "openai/gpt-5.2",
		base: "https://api.openai.com/v1",
		key: "os.environ/OPENAI_API_KEY",
	},
];
const anthEntries = anth
	.map(
		(a) =>
			`  - model_name: ${a.name}\n` +
			`    litellm_params:\n` +
			`      model: ${a.model}\n` +
			`      api_base: ${a.base}\n` +
			`      api_key: ${a.key}`,
	)
	.join("\n");
// Router policy (retries, outlier ejection) + the fallback ladders come from
// bin/routing-policy.json — operators edit the JSON, never code. Ladders
// land under litellm_settings.fallbacks (W219.2): the placement the
// installed litellm reads; router_settings.model_group_fallbacks is a dead
// key (warned + ignored — the 2026-10-06 z.ai TLS outage hard-failed lanes
// that way). Activation BETWEEN fan-outs (a reload drops in-flight streams):
//   bun bin/gateway-config.ts && kill $(lsof -ti tcp:4100 -sTCP:LISTEN)
// (the swarm supervisor respawns :4100 with the new config — W277)
const policy = loadGatewayPolicy();
const fullYaml =
	`# GENERATED by belt gateway tooling (${new Date().toISOString()}) — do not edit by hand.\n` +
	`# PRIVATE: lives in ~/.claude/local-llm/, never committed.\n` +
	`model_list:\n${entries.join("\n")}\n${anthEntries}\n\n` +
	emitRouterSettings(policy) +
	"\n" +
	emitLiteLlmSettings(policy) +
	// Cancel abandoned pre-header provider work, not just the client socket.
	// LiteLLM's separate streaming finalizer still owns post-header cleanup.
	`general_settings:\n  master_key: os.environ/LITELLM_KEY\n  cancel_on_disconnect: true\n`;
const out = `${HOME}/.claude/local-llm/litellm.yaml`;
const temp = `${out}.${crypto.randomUUID()}.tmp`;
try {
	writeFileSync(temp, fullYaml, { mode: 0o600, flag: "wx" });
	renameSync(temp, out);
} catch (error) {
	try {
		unlinkSync(temp);
	} catch {
		/* preserve original error */
	}
	throw error;
}
console.log(
	`wrote ${out}: ${locals.length} local + ${remotesBuilt.entries.length} remote models — live ${discovered.map((d) => `${d.port}=${d.id.slice(13, 40)}`).join(", ")}`,
);
// W270 direct-tier bypass map for non-TS clients (TS uses resolveTarget()).
const directOut = `${HOME}/.claude/local-llm/direct-tiers.json`;
await Bun.write(directOut, `${JSON.stringify(loadDirectTiers(), null, 2)}\n`);
console.log(`wrote ${directOut}`);
// W648 role-class map for non-TS consumers (dispatch briefs, the W512 Task
// pin): role → class → ordered groups + the reasoning-effort axis.
const classOut = `${HOME}/.claude/local-llm/class-tiers.json`;
await Bun.write(classOut, emitClassTiers(policy));
console.log(`wrote ${classOut}`);
