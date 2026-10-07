// bin/router-policy.ts — load + emit belt's LiteLLM routing policy. The
// single config source is bin/routing-policy.yaml (committed default); a
// runtime copy at ~/.claude/local-llm/routing-policy.yaml overrides it, and
// BELT_POLICY overrides both. bin/gateway-config.ts emits the `gateway`
// section as router_settings plus the ladders as litellm_settings.fallbacks
// (W219.2 — the placement the installed litellm reads; verified in pinned
// source, proxy_server.py setattr default → litellm.fallbacks, and router.py
// `_fallbacks = fallbacks or litellm.fallbacks`). router_settings.
// model_group_fallbacks is NOT a key the proxy knows — it is warned on and
// ignored (the 2026-10-06 z.ai TLS outage hard-failed lanes that way).
//
// Emitted engine settings are NATIVE router behavior (pinned-source
// verified, W126 audit docs/research/litellm-enterprise-audit-2026-10-01.md):
// fallbacks = ordered cross-group ladders tried after num_retries;
// allowed_fails + cooldown_time = passive outlier ejection. Buckle owns
// gateway.num_retries; gateway.litellm_num_retries independently controls
// the inner router and defaults to zero. Provider SDK retries stay disabled.
// Owner directives: never flashx; operators edit the YAML, never code.
import { YAML } from "bun";
import { existsSync, readFileSync } from "node:fs";

export interface GatewayPolicy {
	/** Buckle's outer retry budget; independent of the engine below it. */
	num_retries?: number;
	/** Inner LiteLLM router retries (0..3); zero avoids nested retry loops. */
	litellm_num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
}

interface PolicyDoc {
	version?: number;
	gateway?: GatewayPolicy;
}

/** Native-free defaults; the committed YAML carries the same values. */
const DEFAULTS: Required<Omit<GatewayPolicy, "fallbacks">> = {
	num_retries: 1,
	litellm_num_retries: 0,
	allowed_fails: 3,
	cooldown_time: 30,
};

/** Parse a policy document (tests + loader share this path). */
export function parsePolicy(text: string): GatewayPolicy {
	const doc = YAML.parse(text) as PolicyDoc;
	const policy = { ...DEFAULTS, ...(doc.gateway ?? {}) };
	validateInnerRetries(policy.litellm_num_retries);
	return policy;
}

function validateInnerRetries(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 3
	)
		throw new Error(
			"router-policy: gateway.litellm_num_retries must be an integer from 0 to 3",
		);
	return value;
}

/** Resolution order: explicit path → BELT_POLICY → runtime copy in the
 *  local-llm dir → the committed default in bin/. */
export function loadGatewayPolicy(explicitPath?: string): GatewayPolicy {
	const candidates = [
		explicitPath,
		process.env.BELT_POLICY,
		`${process.env.HOME}/.claude/local-llm/routing-policy.yaml`,
		new URL("./routing-policy.yaml", import.meta.url).pathname,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		return parsePolicy(readFileSync(p, "utf8"));
	}
	throw new Error(
		"router-policy: no routing-policy.yaml (BELT_POLICY, ~/.claude/local-llm/, bin/)",
	);
}

/** Emit the router_settings YAML block (newline-terminated, LiteLLM
 *  semantics: allowed_fails + cooldown as passive outlier ejection, retries
 *  with native retry-after backoff). */
export function emitRouterSettings(p: GatewayPolicy): string {
	const innerRetries = validateInnerRetries(
		p.litellm_num_retries ?? DEFAULTS.litellm_num_retries,
	);
	return (
		"router_settings:\n" +
		"  routing_strategy: latency-based-routing\n" +
		`  num_retries: ${innerRetries}\n` +
		"  default_litellm_params:\n" +
		"    max_retries: 0\n" +
		`  allowed_fails: ${p.allowed_fails}\n` +
		`  cooldown_time: ${p.cooldown_time}\n`
	);
}

/** Emit the litellm_settings YAML block carrying the fallback ladders
 *  (W219.2). Empty string when no fallbacks are configured — gateway-config
 *  composes router_settings + litellm_settings + general_settings. Shape is
 *  the native one: a list of single-key maps, validated by Router
 *  .validate_fallbacks. */
export function emitFallbackSettings(p: GatewayPolicy): string {
	const fallbackLines = Object.entries(p.fallbacks ?? {})
		.map(([group, list]) => `    - ${group}: [${(list ?? []).join(", ")}]`)
		.join("\n");
	if (!fallbackLines) return "";
	return `litellm_settings:\n  fallbacks:\n${fallbackLines}\n`;
}

// ─── direct-tier bypass (W270) ───
// Bench 2026-10-02 (REPORT.md, n=12, speed STRONG): stack-engine-local vs
// local-direct = 1.35-3.92× wall, +0.5-2.2 s TTFT per call — the LiteLLM
// proxy hop itself (Python request path + latency-based-routing bookkeeping),
// not belt code. Hot local classes therefore skip :4100 and hit the
// specialist port directly; the gateway keeps cloud ladders + fallbacks.
// Policy data lives in routing-policy.yaml `direct:` (alias → base URL).

export type DirectTiers = Record<string, string>;

const LOOPBACK =
	/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}(\/v1)?\/?$/;

/** Parse the `direct:` section. Only loopback http bases are accepted — a
 *  bypass skips the gateway's auth + accounting, so it must stay on-box. */
export function parseDirect(text: string): DirectTiers {
	const doc = YAML.parse(text) as { direct?: Record<string, unknown> };
	const out: DirectTiers = {};
	for (const [alias, base] of Object.entries(doc.direct ?? {})) {
		if (typeof base !== "string" || !LOOPBACK.test(base))
			throw new Error(
				`router-policy: direct.${alias} must be a loopback http base, got ${JSON.stringify(base)}`,
			);
		out[alias] = base.replace(/\/$/, "").replace(/(\/v1)?$/, "/v1");
	}
	return out;
}

export function loadDirectTiers(explicitPath?: string): DirectTiers {
	const candidates = [
		explicitPath,
		process.env.BELT_POLICY,
		`${process.env.HOME}/.claude/local-llm/routing-policy.yaml`,
		new URL("./routing-policy.yaml", import.meta.url).pathname,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		return parseDirect(readFileSync(p, "utf8"));
	}
	return {};
}

/** Where an OpenAI-wire client should send `model`: the specialist port for
 *  a direct tier, else the gateway. */
export function resolveTarget(
	model: string,
	gatewayBase: string,
	direct: DirectTiers = loadDirectTiers(),
): { base: string; direct: boolean } {
	const d = direct[model];
	return d ? { base: d, direct: true } : { base: gatewayBase, direct: false };
}
