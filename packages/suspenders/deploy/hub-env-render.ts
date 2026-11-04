// deploy/hub-env-render.ts — the compose .env renderer, extracted from
// hubctl.ts (W2595 decompose: hubctl rides the 1200-line stop-rule band,
// shrink-only). Declared knobs only — the compose template's own defaults
// cover everything else; single source of truth stays the profile.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HubProfile, StackAuth } from "../hooks/lib/stack-config.ts";
import { hubMetricsEnv } from "./hub-metrics.ts";
import { resolveHubOrigin } from "./hub-ref-preflight.ts";

/** A local hub must not publish over an existing .local service. The registry
 * is machine-owned, so this check follows the operator's actual front. */
export function assertLocalPortReservations(
	hub: HubProfile,
	name: string,
): void {
	if (hub.deploy?.ssh) return;
	const path = join(
		process.env.HOME ?? homedir(),
		".local/state/klh-local/registry.json",
	);
	if (!existsSync(path)) return;
	const services = JSON.parse(readFileSync(path, "utf8")) as Array<{
		name?: string;
		port?: number;
	}>;
	if (!Array.isArray(services))
		throw new Error(`${path} is not a service list`);
	for (const [kind, port] of [
		["buckle", hub.buckle_port],
		["board", hub.board_port],
		["store", hub.store_port],
		["belt", hub.belt_port],
	] as const) {
		if (!port) continue;
		const conflict = services.find((service) => Number(service.port) === port);
		if (conflict)
			throw new Error(
				`${name} ${kind}_port ${port} conflicts with ${conflict.name ?? "a registered .local service"}; choose another port in stack.json`,
			);
	}
}

/** Render the compose .env from the profile — declared knobs only (the
 *  template's own defaults cover everything else; single source of truth). */
export function renderEnv(
	hub: HubProfile,
	name: string,
	auth?: StackAuth,
	version?: string,
): string {
	assertLocalPortReservations(hub, name);
	// W1302.3: the origin/ref shape gate moved to deploy/hub-ref-preflight.ts
	// (shared with the activation preflight — ONE shape gate, one error set)
	const { origin, ref } = resolveHubOrigin(hub, version);
	const lines = [`HUB_NAME=${name}`];
	for (const [key, value] of Object.entries(hubMetricsEnv(hub)))
		lines.push(`${key}=${value}`);
	const kv = (key: string, v: unknown): void => {
		if (v !== undefined) lines.push(`${key}=${String(v)}`);
	};
	kv("HUB_BUCKLE_PORT", hub.buckle_port);
	kv("HUB_BUCKLE_BIND", hub.bind);
	kv("HUB_FLEET_REF", ref);
	kv("HUB_FLEET_REPO_URL", origin);
	kv("HUB_FLEET_SRC", hub.repos?.src);
	kv("HUB_BUCKLE_ENV_FILE", hub.secrets?.buckle_root_key);
	// W2632: the hub's repo→tier account policy (W1265.1) — a secrets PATH on
	// the hub names the operator-maintained 0600 repo-tier-policy.yaml; hubctl
	// push stages it beside the compose (mounted read-only at the fixed
	// container path below). Undeclared = the .env line is absent = empty
	// interpolation = unset env inside (buckle's chain skips empty candidates
	// and falls to its W1265.2 default:general posture — inert stays true).
	if (hub.secrets?.repo_tier_policy)
		kv("HUB_REPO_TIER_POLICY", "/etc/klh/repo-tier-policy.yaml");
	if (auth?.required !== undefined)
		kv("HUB_BUCKLE_AUTH", auth.required ? "on" : "off");
	// W372: the auth.oidc/auth.tokens blocks materialize as env — Entra-ready
	// by config (values live ONLY in the machine stack.json; partial blocks
	// fail closed at render, a hub never ships a half-declared posture).
	if (auth?.tokens?.ttlHours !== undefined)
		kv("HUB_BUCKLE_AUTH_TTL_HOURS", auth.tokens.ttlHours);
	if (auth?.oidc) {
		const o = auth.oidc;
		if (!o.issuer || !o.audience)
			throw new Error(
				"auth.oidc requires issuer + audience (Entra values live in the machine stack.json, never in the repo)",
			);
		kv("HUB_BUCKLE_OIDC_ENFORCED", o.enforced === false ? "off" : "on");
		kv("HUB_BUCKLE_OIDC_ISSUER", o.issuer);
		kv("HUB_BUCKLE_OIDC_JWKS_URI", o.jwksUri);
		kv("HUB_BUCKLE_OIDC_AUDIENCE", o.audience);
		kv("HUB_BUCKLE_OIDC_REQUIRED_SCOPE", o.requiredScope);
	}
	kv("HUB_BOARD_PORT", hub.board_port);
	kv("HUB_BOARD_BIND", hub.board_bind);
	kv("HUB_ALLOWED_HOSTS", hub.allowed_hosts?.join(","));
	// W362: peer edge labels — the start-topology as data; hosts/ports/keys
	// resolve at runtime behind the labels (resolveHub chain / stack.json).
	kv("HUB_PEERS", hub.peers?.join(","));
	kv("HUB_SERVICES_JSON", hub.services_json);
	kv("HUB_STORE_PORT", hub.store_port);
	kv("HUB_BELT_BIND", hub.belt_bind);
	kv("HUB_BELT_PORT", hub.belt_port);
	// Compose profiles accumulate: each optional service appends its own, and
	// one declaration never clobbers another (W1217).
	const profiles: string[] = [];
	if (hub.belt_model) {
		const upstream = new URL(hub.belt_model.upstream);
		if (
			!["http:", "https:"].includes(upstream.protocol) ||
			upstream.username ||
			upstream.password
		)
			throw new Error(
				"belt_model.upstream must be an HTTP URL without credentials",
			);
		profiles.push("belt-model");
		kv("HUB_BELT_MODEL_PORT", hub.belt_model.port);
		kv("HUB_BELT_MODEL_HEALTH_PORT", hub.belt_model.health_port);
		kv("HUB_BELT_MODEL_UPSTREAM", upstream.href.replace(/\/$/, ""));
	}
	// W1217: the knowledge sink — declaring `knowledge:` enables the profile
	// (knowledge-api container + its health probe sidecar); undeclared knobs
	// fall through to the template defaults, solo posture stays unchanged.
	if (hub.knowledge) {
		profiles.push("knowledge");
		kv("HUB_KNOWLEDGE_SINK_PORT", hub.knowledge.port);
		kv("HUB_KNOWLEDGE_SINK_HEALTH_PORT", hub.knowledge.health_port);
	}
	// W2329: the dataplane face — declaring `dataplane:` enables the profile
	// (dataplane-api container + its health probe sidecar, knowledge-sink
	// pattern); own port, never the LLM gateway front door.
	if (hub.dataplane) {
		profiles.push("dataplane");
		kv("HUB_DATAPLANE_PORT", hub.dataplane.port);
		kv("HUB_DATAPLANE_HEALTH_PORT", hub.dataplane.health_port);
	}
	// W2595: litellm behind every buckle — declaring `litellm:` enables the
	// profile (engine container + health sidecar); the operator-maintained
	// 0600 litellm.yaml + copilot token cache sit beside the compose dir.
	if (hub.litellm) {
		profiles.push("litellm");
		kv("HUB_LITELLM_PORT", hub.litellm.port);
		kv("HUB_LITELLM_HEALTH_PORT", hub.litellm.health_port);
	}
	if (profiles.length > 0) kv("COMPOSE_PROFILES", profiles.join(","));
	// health sidecar ports (W422.10) — compose health hits the SIDECAR
	kv("HUB_BUCKLE_HEALTH_PORT", hub.buckle_health_port);
	kv("HUB_BOARD_HEALTH_PORT", hub.board_health_port);
	kv("HUB_STORE_HEALTH_PORT", hub.store_health_port);
	kv("HUB_BELT_HEALTH_PORT", hub.belt_health_port);
	// W763 hub model store — face + health sidecar ports
	kv("HUB_MODEL_STORE_PORT", hub.model_store_port);
	kv("HUB_MODEL_STORE_HEALTH_PORT", hub.model_store_health_port);
	// synthetic readiness (W467) — the completion leg's verdict port + model
	kv("HUB_BUCKLE_READY_PORT", hub.buckle_ready_port);
	kv("HUB_READY_MODEL", hub.ready_model);
	// W688.7.1: enterprise entrypoint + private-network ladder egress hosts
	kv("HUB_BUCKLE_ENTRY", hub.buckle_entry);
	kv("HUB_HTTP_UPSTREAM_HOSTS", hub.http_upstream_hosts?.join(","));
	// W688.3: overlay code-loader knobs (env plumbing only, config-over-code;
	// unset = solo posture — the loader treats unset exactly as before)
	kv("HUB_KLH_OVERLAY_DIR", hub.overlay?.dir);
	kv("HUB_KLH_OVERLAY_SHA256", hub.overlay?.sha256);
	kv("HUB_KLH_OVERLAY_ALLOW", hub.overlay?.allow);
	// W854: mDNS advertisement — what _klh-hub._tcp advertises (the
	// announcer falls through to the template defaults for undeclared knobs;
	// advertised port defaults to HUB_BUCKLE_PORT in the template)
	kv("HUB_MDNS_PORT", hub.mdns?.port);
	kv("HUB_MDNS_ADDR", hub.mdns?.addr);
	kv("HUB_MDNS_HOSTNAME", hub.mdns?.hostname);
	kv("HUB_MDNS_INTERVAL_MS", hub.mdns?.interval_ms);
	kv("HUB_MDNS_HEALTH_PORT", hub.mdns?.health_port);
	kv("HUB_MDNS_SIDECAR_PORT", hub.mdns?.sidecar_port);
	return `${lines.join("\n")}\n`;
}
