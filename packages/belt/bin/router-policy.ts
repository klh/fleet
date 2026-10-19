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
// the inner router and preserves the existing default of one. Operators opt
// into zero for verified Buckle-fronted deployments. SDK retries stay disabled.
// Owner directives: never flashx; operators edit the YAML, never code.
import { YAML } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { chatEntries } from "./registry.ts";

export interface GatewayPolicy {
	/** Buckle's outer retry budget; independent of the engine below it. */
	num_retries?: number;
	/** Inner router retries (0..3); opt into zero behind a verified retry owner. */
	litellm_num_retries?: number;
	/** Keep inner fallback ladders unless a verified front owns those hops. */
	litellm_fallbacks?: boolean;
	/** Background /health loop (W886, W499 surface 3): cached probes every
	 *  300s instead of per-call health cost. Dormant key-gated model rows
	 *  opt out per deployment (model_info.disable_background_health_check). */
	litellm_health_checks?: boolean;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
	/** W648 role-class rows — validated at parse, resolved per request. */
	classes?: ClassPolicy;
	roles?: Record<string, RoleClass>;
	reasoning?: ReasoningPolicy;
}

interface PolicyDoc {
	version?: number;
	gateway?: GatewayPolicy;
	classes?: unknown;
	roles?: unknown;
	reasoning?: unknown;
}

/** Native-free defaults; the committed YAML carries the same values. */
const DEFAULTS: Required<Omit<GatewayPolicy, "fallbacks">> = {
	num_retries: 1,
	litellm_num_retries: 1,
	litellm_fallbacks: true,
	litellm_health_checks: true,
	allowed_fails: 3,
	cooldown_time: 30,
};

/** Parse a policy document (tests + loader share this path). */
export function parsePolicy(text: string): GatewayPolicy {
	const doc = YAML.parse(text) as PolicyDoc;
	const policy = { ...DEFAULTS, ...(doc.gateway ?? {}) };
	validateInnerRetries(policy.litellm_num_retries);
	validateInnerFallbacks(policy.litellm_fallbacks);
	validateHealthChecks(policy.litellm_health_checks);
	if (doc.classes !== undefined) policy.classes = parseClasses(doc.classes);
	if (doc.roles !== undefined) policy.roles = parseRoles(doc.roles);
	if (doc.reasoning !== undefined)
		policy.reasoning = parseReasoning(doc.reasoning);
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

function validateInnerFallbacks(value: unknown): boolean {
	if (typeof value !== "boolean")
		throw new Error(
			"router-policy: gateway.litellm_fallbacks must be a boolean",
		);
	return value;
}

function validateHealthChecks(value: unknown): boolean {
	if (typeof value !== "boolean")
		throw new Error(
			"router-policy: gateway.litellm_health_checks must be a boolean",
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
 *  (W219.2). Empty when omitted or explicitly disabled for the inner engine — gateway-config
 *  composes router_settings + litellm_settings + general_settings. Shape is
 *  the native one: a list of single-key maps, validated by Router
 *  .validate_fallbacks. */
export function emitFallbackSettings(p: GatewayPolicy): string {
	if (
		!validateInnerFallbacks(p.litellm_fallbacks ?? DEFAULTS.litellm_fallbacks)
	)
		return "";
	const fallbackLines = Object.entries(p.fallbacks ?? {})
		.map(([group, list]) => `    - ${group}: [${(list ?? []).join(", ")}]`)
		.join("\n");
	if (!fallbackLines) return "";
	return `litellm_settings:\n  fallbacks:\n${fallbackLines}\n`;
}

/** Emit the general_settings YAML block — the master key plus the W886
 *  background health loop. general_settings is the section litellm reads
 *  background_health_checks/health_check_interval from (docs.litellm.ai/
 *  docs/proxy/health); caching the /health probes avoids the per-call token
 *  cost. Dormant key-gated rows opt out per deployment in gateway-config. */
export function emitGeneralSettings(p: GatewayPolicy): string {
	const on = validateHealthChecks(
		p.litellm_health_checks ?? DEFAULTS.litellm_health_checks,
	);
	return (
		"general_settings:\n" +
		"  master_key: os.environ/LITELLM_KEY\n" +
		(on
			? "  background_health_checks: true\n  health_check_interval: 300\n"
			: "")
	);
}

// ─── direct-tier bypass (W270, completed W289) ───
// Bench 2026-10-02 (REPORT.md, n=12, speed STRONG): stack-engine-local vs
// local-direct = 1.35-3.92× wall, +0.5-2.2 s TTFT per call — the LiteLLM
// proxy hop itself (Python request path + latency-based-routing bookkeeping),
// not belt code. Hot local classes therefore skip :4100 and hit the
// specialist port directly; the gateway keeps cloud ladders + fallbacks.
// The `direct:` tier map is EMITTED-ONLY (W289): routing-policy.yaml no
// longer carries a hand-written section — registry-emit `direct` writes the
// object-shaped rows (bin/registry.ts is the one source); parseDirect still
// reads the legacy `alias: <url>` shape so operator YAML survives.

export type DirectTiers = Record<string, string>;

const LOOPBACK =
	/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}(\/v1)?\/?$/;

/** Pull the loopback base out of a direct row — the legacy `alias: <url>`
 *  string shape or the emitted object shape (`url:` plus descriptive
 *  fields); anything else parses to null. */
const directBaseOf = (spec: unknown): string | null => {
	if (typeof spec === "string") return spec;
	if (typeof spec === "object" && spec !== null && !Array.isArray(spec)) {
		const url = (spec as { url?: unknown }).url;
		if (typeof url === "string") return url;
	}
	return null;
};

/** Parse the `direct:` section. Only loopback http bases are accepted — a
 *  bypass skips the gateway's auth + accounting, so it must stay on-box.
 *  Rows may be the legacy `alias: <url>` strings or the emitted object
 *  shape; both normalize to alias → loopback /v1 base. */
export function parseDirect(text: string): DirectTiers {
	const doc = YAML.parse(text) as { direct?: Record<string, unknown> };
	const out: DirectTiers = {};
	for (const [alias, spec] of Object.entries(doc.direct ?? {})) {
		const base = directBaseOf(spec);
		if (base === null || !LOOPBACK.test(base))
			throw new Error(
				`router-policy: direct.${alias} must be a loopback http base (alias: <url> or {url: ...}), got ${JSON.stringify(spec)}`,
			);
		out[alias] = base.replace(/\/$/, "").replace(/(\/v1)?$/, "/v1");
	}
	return out;
}

/** Registry-derived tiers (W289 emitted-only): the hot local chat classes a
 *  client may address without the gateway hop — resident, OpenAI-protocol
 *  rows only (on-demand rows may be cold; the gateway owns spawn+fallback,
 *  rerank/embed/classify speak other API shapes). */
export const directTiersFromRegistry = (): DirectTiers =>
	Object.fromEntries(
		chatEntries()
			.filter((e) => e.tier === "resident")
			.map((e) => [
				e.alias,
				`http://127.0.0.1:${e.port}${e.protocol === "openai" ? "/v1" : ""}`,
			]),
	);

/** The W280 emitted artifact (gateway-config.ts writes direct-tiers.json in
 *  the SAME regen as litellm.yaml): what the LIVE engine actually serves, so
 *  "may I skip it" is decided against engine truth, not next-regen YAML. */
export const directTiersArtifactPath = (): string =>
	`${process.env.HOME}/.claude/local-llm/direct-tiers.json`;

/** The emitted artifact's row grammar as a PURE parse (W726: the one
 *  reader for direct-tiers.json — board enhance + the prompt bench read
 *  the map through this, not hand-rolled copies): only mapping bodies
 *  count, rows must pass the same loopback grammar as parseDirect (a
 *  hand-edited row fails alone — belt emission never writes bad rows),
 *  /v1-normalized. Bad body → null so the caller falls back. */
export function parseDirectTiersArtifact(text: string): DirectTiers | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return null;
	const out: DirectTiers = {};
	let sawRow = false;
	for (const [alias, base] of Object.entries(raw as Record<string, unknown>)) {
		sawRow = true;
		if (typeof base === "string" && LOOPBACK.test(base))
			out[alias] = base.replace(/\/$/, "").replace(/(\/v1)?$/, "/v1");
	}
	// an empty mapping falls through to the YAML chain too — the YAML is the
	// source, so fresh (un-regenerated) rows must not be masked by a stale {}
	if (!sawRow) return null;
	return out;
}

/** Read the emitted artifact: parseDirectTiersArtifact on the file bytes.
 *  Missing/corrupt → null so the caller falls back to the YAML chain. */
export function readDirectTiersArtifact(
	path = directTiersArtifactPath(),
): DirectTiers | null {
	try {
		return parseDirectTiersArtifact(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function loadDirectTiers(
	explicitPath?: string,
	home?: string,
): DirectTiers {
	const h = home ?? process.env.HOME ?? "";
	// operator pin (explicit path / BELT_POLICY) keeps YAML semantics and
	// overrides everything — tests pin fixtures through it
	const pinned = [explicitPath, process.env.BELT_POLICY].filter(
		(p): p is string => typeof p === "string" && p.length > 0,
	);
	for (const p of pinned) {
		if (!existsSync(p)) continue;
		return parseDirect(readFileSync(p, "utf8"));
	}
	const artifact = readDirectTiersArtifact(
		`${h}/.claude/local-llm/direct-tiers.json`,
	);
	if (artifact) return artifact;
	const candidates = [
		`${h}/.claude/local-llm/routing-policy.yaml`,
		new URL("./routing-policy.yaml", import.meta.url).pathname,
	].filter((p) => p.length > 0);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		const rows = parseDirect(readFileSync(p, "utf8"));
		if (Object.keys(rows).length > 0) return rows;
	}
	return directTiersFromRegistry();
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

// ─── role-class routing (W648, oh-my-codex §1 lift) ───
// Declarative class rows in routing-policy.yaml: classes map
// frontier/standard/spark to ordered group ladders (the groups are the
// existing litellm model_name / buckle group / direct-tier aliases — buckle
// and litellm keep resolving group → provider natively). Any role or lane
// named *-low drops to the spark class with no registry edit; reasoning
// effort rides as a SEPARATE axis (role row > class row > default).
export const ROLE_CLASSES = ["frontier", "standard", "spark"] as const;
export type RoleClass = (typeof ROLE_CLASSES)[number];

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ClassPolicy {
	frontier?: string[];
	standard?: string[];
	spark?: string[];
}

export interface ReasoningPolicy {
	default?: ReasoningEffort;
	classes?: Partial<Record<RoleClass, ReasoningEffort>>;
	roles?: Record<string, ReasoningEffort>;
}

/** Group and role names share one grammar — the belt-facing alias namespace
 *  (litellm model_name / buckle group / direct-tier key). */
const TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function parseEffort(v: unknown): ReasoningEffort {
	if (
		typeof v !== "string" ||
		!REASONING_EFFORTS.includes(v as ReasoningEffort)
	)
		throw new Error(
			`router-policy: reasoning effort must be one of ${REASONING_EFFORTS.join("|")}`,
		);
	return v as ReasoningEffort;
}

/** Parse the `classes:` rows — only the three known classes, each a
 *  non-empty ordered list of group names. Unknown class keys fail closed
 *  (a misspelled class would otherwise route nobody, silently). */
function parseClasses(raw: unknown): ClassPolicy {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error(
			"router-policy: classes must be a map of class → [group names]",
		);
	const out: ClassPolicy = {};
	for (const [cls, groups] of Object.entries(raw)) {
		if (!ROLE_CLASSES.includes(cls as RoleClass))
			throw new Error(
				`router-policy: classes.${cls} is not one of ${ROLE_CLASSES.join("|")}`,
			);
		if (
			!Array.isArray(groups) ||
			groups.length === 0 ||
			groups.some((g) => typeof g !== "string" || !TOKEN_RE.test(g))
		)
			throw new Error(
				`router-policy: classes.${cls} must be a non-empty list of group names (letters/digits/._-, ≤64 chars)`,
			);
		out[cls as RoleClass] = groups as string[];
	}
	return out;
}

/** Parse the `roles:` override map — grammar-checked role names → class. */
function parseRoles(raw: unknown): Record<string, RoleClass> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("router-policy: roles must be a map of role → class");
	const out: Record<string, RoleClass> = {};
	for (const [role, cls] of Object.entries(raw)) {
		if (!TOKEN_RE.test(role))
			throw new Error(
				`router-policy: roles.${role} must be a role name (letters/digits/._-, ≤64 chars)`,
			);
		if (!ROLE_CLASSES.includes(cls as RoleClass))
			throw new Error(
				`router-policy: roles.${role} is not one of ${ROLE_CLASSES.join("|")}`,
			);
		out[role] = cls as RoleClass;
	}
	return out;
}

/** Parse the `reasoning:` axis — model-independent effort (W648): a
 *  per-role override map, class-level defaults, and a global default. Every
 *  value must be a known effort (low..xhigh) — invalid tiers fail closed. */
function parseReasoning(raw: unknown): ReasoningPolicy {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error(
			"router-policy: reasoning must be a map (default/classes/roles)",
		);
	const rec = raw as Record<string, unknown>;
	const out: ReasoningPolicy = {};
	if (rec.default !== undefined) out.default = parseEffort(rec.default);
	if (rec.classes !== undefined) {
		if (typeof rec.classes !== "object" || rec.classes === null)
			throw new Error(
				"router-policy: reasoning.classes must be a map of class → effort",
			);
		const cls: Partial<Record<RoleClass, ReasoningEffort>> = {};
		for (const [k, v] of Object.entries(rec.classes)) {
			if (!ROLE_CLASSES.includes(k as RoleClass))
				throw new Error(
					`router-policy: reasoning.classes.${k} is not one of ${ROLE_CLASSES.join("|")}`,
				);
			cls[k as RoleClass] = parseEffort(v);
		}
		out.classes = cls;
	}
	if (rec.roles !== undefined) {
		if (typeof rec.roles !== "object" || rec.roles === null)
			throw new Error(
				"router-policy: reasoning.roles must be a map of role → effort",
			);
		const roles: Record<string, ReasoningEffort> = {};
		for (const [k, v] of Object.entries(rec.roles)) {
			if (!TOKEN_RE.test(k))
				throw new Error(
					`router-policy: reasoning.roles.${k} must be a role name (letters/digits/._-, ≤64 chars)`,
				);
			roles[k] = parseEffort(v);
		}
		out.roles = roles;
	}
	return out;
}

/** OMX §1 role→class: an explicit `roles:` row wins, a `-low` name suffix
 *  drops to spark, everything else rides the standard lane. */
export function resolveRoleClass(
	policy: GatewayPolicy,
	role: string,
): RoleClass {
	const explicit = policy.roles?.[role];
	if (explicit) return explicit;
	if (role.endsWith("-low")) return "spark";
	return "standard";
}

/** Ordered group ladder for a class. standard inherits frontier when unset
 *  (OMX §1: the cheap lane is the opt-in, expensive by default); spark
 *  inherits standard → frontier. Empty = no rows configured (a runtime
 *  copy predating the schema) — callers fall back to today's behavior. */
export function resolveClassGroups(
	policy: GatewayPolicy,
	cls: RoleClass,
): string[] {
	const c = policy.classes ?? {};
	if (cls === "frontier") return c.frontier ?? [];
	if (cls === "standard") return c.standard ?? c.frontier ?? [];
	return c.spark ?? c.standard ?? c.frontier ?? [];
}

/** Effort precedence: role row > class row > global default > medium. */
export function resolveReasoningEffort(
	policy: GatewayPolicy,
	role: string,
): ReasoningEffort {
	const r = policy.reasoning;
	const cls = resolveRoleClass(policy, role);
	return r?.roles?.[role] ?? r?.classes?.[cls] ?? r?.default ?? "medium";
}

/** The class-tiers.json artifact (W648): the resolved class map for non-TS
 *  consumers — dispatch brief composition and the W512 Task pin read this
 *  instead of importing belt code. Groups stay the existing belt-facing
 *  aliases; buckle/litellm resolve group → provider as before. */
export function emitClassTiers(policy: GatewayPolicy): string {
	return `${JSON.stringify(
		{
			version: 1,
			classes: {
				frontier: resolveClassGroups(policy, "frontier"),
				standard: resolveClassGroups(policy, "standard"),
				spark: resolveClassGroups(policy, "spark"),
			},
			roles: policy.roles ?? {},
			reasoning: {
				default: policy.reasoning?.default ?? "medium",
				classes: policy.reasoning?.classes ?? {},
				roles: policy.reasoning?.roles ?? {},
			},
		},
		null,
		2,
	)}\n`;
}
