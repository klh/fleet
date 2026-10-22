// src/policy.ts — port of belt bin/router-policy.ts (W124): same policy
// override chain. Runtime JSON takes precedence over legacy YAML, and
// BUCKLE_POLICY / BELT_POLICY override both. Operators edit machine config.
//
// Everything the policy expresses is native-router behavior ported from
// LiteLLM 1.103.0 (MIT; pinned-source verified W126/W129): fallbacks =
// ordered cross-group ladders tried after num_retries per tier; allowed_fails
// + cooldown_time = passive outlier ejection; num_retries = per-tier retries
// whose backoff honors the upstream retry-after header with jitter
// (utils.py::_calculate_retry_after semantics).

import { existsSync, readFileSync } from "node:fs";
import { YAML } from "bun";
import type { ProviderPoolPolicy } from "./provider-admission-core.ts";

/** OWNER DIRECTIVE (W124, lesson.fanout-rate-budget): flashx appears in no
 *  group, no ladder, no alias — same upstream family saturates together and
 *  the tier is too expensive. Enforced structurally: the ladder walk refuses
 *  flashx tiers and the candidate table never builds flashx rows. */
export const FLASHX = /flashx/i;

export interface GatewayPolicy {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
	// W136 routing laws §3.2: per-group capability tags — the string the hint
	// tag cloud regexps against. Operators edit the YAML, never code; absent
	// tags contribute no text (the file stays v1-compatible).
	tags?: Record<string, string[]>;
	// buckle extension knobs (belt ignores unknown keys — shared file stays
	// compatible): backoff cap for absent retry-after, provider retry-after
	// floor cap (W695.6.1 — a quota wall's days-long retry-after must not
	// park the walk), per-attempt timeout.
	retry_max_delay_s?: number;
	retry_after_cap_s?: number;
	request_timeout_s?: number;
	/** Maximum time to obtain response headers across the entire selected
	 *  candidate and fallback walk. Active streaming bodies use their own
	 *  idle/total guards after headers arrive. */
	first_byte_budget_s?: number;
	// W450 long-generation deadlines: a streaming body that stalls longer
	// than the idle deadline is hung (abort); a healthy stream may run to
	// the total deadline regardless of request_timeout_s. Non-streaming
	// exchanges keep request_timeout_s as their whole-exchange cap.
	stream_idle_timeout_s?: number;
	stream_total_timeout_s?: number;
	// W142 knowledge-aids policy (buckle enforcement, belt ignores): the
	// preseed allowlist is the operator's on-switch per domain; compress is
	// DEFAULT-OFF per the W137 economics (cache reads are 0.1x — compression
	// must prove ROI on cache-miss traffic before an operator flips it).
	aids?: AidsPolicy;
	// W1078 provider-account admission: pool id -> bounded pacing policy,
	// EXPLICIT machine config (no account limit is ever inferred — every
	// number is operator-owned). A deployment binds to one pool via
	// adapter_config.provider_pool; an unbound pool id or malformed binding
	// is startup-fatal in the router (fail-closed, never silently off).
	provider_pools?: Record<string, ProviderPoolPolicy>;
}

/** W142 aids policy (routing-policy.yaml `aids:` block). Belt ignores the
 *  block; buckle refuses what policy forbids with an honest skip. */
export interface AidsPolicy {
	preseed?: {
		default?: "on" | "off";
		domains?: string[];
		ttl_s?: number;
		knowledge_url?: string;
	};
	"cache-align"?: { default?: "on" | "off" };
	compress?: { default?: "on" | "off"; max_prose_bytes?: number };
	// W4 expand (W288 retarget): orchestrate-enhance declares `expand` — the
	// user goal is expanded with an architectural-wants digest (fleet laws +
	// repo conventions) by the LOCAL DIRECT tier, one candidate, no ladder
	// walk, never a cloud row. DEFAULT-OFF per the W137 economics law: an
	// extra LLM hop proves ROI before operators flip it onto the path.
	expand?: {
		default?: "on" | "off";
		group?: string; // the local direct tier; default local-swarm
		timeout_ms?: number;
		max_goal_chars?: number;
		max_digest_bytes?: number;
	};
	/** W5 prompt pipeline IN: the response-side condense is sideband-only
	 *  (served bytes never change), so declarations are honored by default;
	 *  `default: "off"` is the operator kill switch. */
	"condense-in"?: { default?: "on" | "off"; max_bytes?: number };
	/** W207 trajectory pruning (diet.ts): the gateway tombstones stale tool
	 *  results past the keep-window pre-routing. DEFAULT-OFF (W137
	 *  economics): a prefix rewrite costs provider KV-cache re-reads — it
	 *  must prove ROI on cache-miss traffic before an operator flips it. */
	prune?: {
		default?: "on" | "off";
		keep_turns?: number;
		min_bytes?: number;
		max_store_bytes?: number;
	};
	// W171 federation phase 3: opt-in aggregate self-report. The hub lists
	// the teams a spoke may report for; ABSENT BLOCK = OFF (the default —
	// no teams, no reporting, the manifest carries no rule at all).
	federation?: FederationPolicy;
}

/** W171: routing-policy.yaml `gateway.federation.self_report` — per-team
 *  opt-in flag. Belt ignores the block; the manifest carries it to spokes
 *  as the `federation.self_report` rule. */
export interface FederationPolicy {
	self_report?: { teams?: string[] };
}

interface PolicyDoc {
	version?: number;
	gateway?: GatewayPolicy;
	tags?: Record<string, string[]>;
	aids?: AidsPolicy;
}

/** Native-free defaults; the committed YAML carries the same values. */
export const POLICY_DEFAULTS: Required<
	Omit<
		GatewayPolicy,
		| "fallbacks"
		| "tags"
		| "retry_max_delay_s"
		| "retry_after_cap_s"
		| "request_timeout_s"
		| "first_byte_budget_s"
		| "stream_idle_timeout_s"
		| "stream_total_timeout_s"
		| "aids"
		| "provider_pools"
	>
> & {
	retry_max_delay_s: number;
	retry_after_cap_s: number;
	request_timeout_s: number;
	first_byte_budget_s: number;
	stream_idle_timeout_s: number;
	stream_total_timeout_s: number;
} = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
	retry_max_delay_s: 8,
	retry_after_cap_s: 60,
	request_timeout_s: 120,
	first_byte_budget_s: 240,
	stream_idle_timeout_s: 60,
	stream_total_timeout_s: 900,
};

/** Parse a policy file: gateway knobs + the W136 tags block. */
export function parsePolicy(
	text: string,
	format: "auto" | "json" | "yaml" = "auto",
): GatewayPolicy {
	const trimmed = text.trimStart();
	const isJson =
		format === "json" ||
		(format === "auto" && (trimmed.startsWith("{") || trimmed.startsWith("[")));
	const doc = (
		isJson ? JSON.parse(text) : YAML.parse(text)
	) as PolicyDoc | null;
	if (doc === null || typeof doc !== "object" || Array.isArray(doc))
		throw new Error("policy: policy must be an object");
	const gateway = doc?.gateway ?? {};
	const policy: GatewayPolicy = {
		...POLICY_DEFAULTS,
		...gateway,
		tags: doc?.tags ?? {},
		aids: doc?.aids ?? {},
	};
	const attempt = policy.request_timeout_s ?? POLICY_DEFAULTS.request_timeout_s;
	const walk =
		policy.first_byte_budget_s ?? POLICY_DEFAULTS.first_byte_budget_s;
	if (
		!Number.isFinite(attempt) ||
		attempt <= 0 ||
		!Number.isFinite(walk) ||
		walk < attempt
	)
		throw new Error(
			"policy: first_byte_budget_s must be at least request_timeout_s",
		);
	// W1078: every configured pool policy must be complete and bounded — the
	// exact five positive safe integers with maxOutstanding >= concurrency.
	// A malformed policy refuses startup (fail-closed), never degrades to
	// unbounded forwarding.
	const pools = policy.provider_pools ?? {};
	for (const [id, pool] of Object.entries(pools)) {
		const five =
			pool !== null &&
			typeof pool === "object" &&
			Object.keys(pool).length === 5 &&
			Number.isSafeInteger(pool.concurrency) &&
			pool.concurrency > 0 &&
			Number.isSafeInteger(pool.intervalCap) &&
			pool.intervalCap > 0 &&
			Number.isSafeInteger(pool.intervalMs) &&
			pool.intervalMs > 0 &&
			Number.isSafeInteger(pool.maxOutstanding) &&
			pool.maxOutstanding > 0 &&
			Number.isSafeInteger(pool.queueWaitMs) &&
			pool.queueWaitMs > 0;
		if (!five || pool.maxOutstanding < pool.concurrency)
			throw new Error(
				`policy: provider_pools."${id}" must carry exactly five positive integers with maxOutstanding >= concurrency`,
			);
	}
	return policy;
}

const jsonSibling = (path: string): string =>
	path.replace(/\.ya?ml$/i, ".json");

const formatOf = (path: string): "json" | "yaml" =>
	path.endsWith(".json") ? "json" : "yaml";

/** Resolution order: explicit path → BUCKLE_POLICY → BELT_POLICY → runtime
 *  copy in the local-llm dir → the committed default in the repo root. */
export function loadGatewayPolicy(explicitPath?: string): GatewayPolicy {
	const pinned = [
		explicitPath,
		process.env.BUCKLE_POLICY,
		process.env.BELT_POLICY,
	];
	const home = process.env.HOME ?? "";
	const candidates = [
		...pinned.flatMap((path) => (path ? [jsonSibling(path), path] : [])),
		`${home}/.claude/local-llm/routing-policy.json`,
		`${home}/.claude/local-llm/routing-policy.yaml`,
		new URL("../routing-policy.json", import.meta.url).pathname,
		new URL("../routing-policy.yaml", import.meta.url).pathname,
	];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		return parsePolicy(readFileSync(p, "utf8"), formatOf(p));
	}
	throw new Error(
		"policy: no routing-policy.json or legacy YAML (BUCKLE_POLICY/BELT_POLICY, ~/.claude/local-llm/, repo root)",
	);
}

// ─── prefs: allow_cloud / cost_speed, the owner's escalation switches ───
// Belt's prefs.json (bin/router-shim.ts) is the file this machine already
// runs; defaults are conservative: cloud off, balanced.
export interface Prefs {
	cost_speed: "balanced" | "cost" | "speed" | "quality";
	allow_cloud: boolean;
}

export const PREFS_DEFAULTS: Prefs = {
	cost_speed: "balanced",
	allow_cloud: false,
};

/** Prefs resolution: explicit path → BUCKLE_PREFS → the belt prefs file.
 *  Missing/unreadable file → defaults (loading never throws). */
export function loadPrefs(explicitPath?: string): Prefs {
	const p =
		explicitPath ??
		process.env.BUCKLE_PREFS ??
		`${process.env.HOME}/.claude/local-llm/prefs.json`;
	try {
		const doc = JSON.parse(readFileSync(p, "utf8")) as Partial<Prefs>;
		const cs = doc.cost_speed;
		return {
			cost_speed:
				cs !== undefined &&
				(["balanced", "cost", "speed", "quality"] as const).includes(cs)
					? cs
					: PREFS_DEFAULTS.cost_speed,
			allow_cloud: doc.allow_cloud === true,
		} satisfies Prefs;
	} catch {
		return { ...PREFS_DEFAULTS };
	}
}
