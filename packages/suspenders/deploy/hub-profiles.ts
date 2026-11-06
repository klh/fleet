// deploy/hub-profiles.ts — W2329: the optional compose-profile accumulation
// extracted from renderEnv (the 1200-line stop rule bites — the
// belt_model/knowledge/litellm/dataplane blocks live here, one responsibility).
// Compose profiles accumulate: each optional service appends its own, and
// one declaration never clobbers another (W1217).
import type { HubProfile } from "../hooks/lib/stack-config.ts";

/** Sink for rendered `KEY=value` lines (renderEnv owns the final join). */
export type EnvSink = (key: string, v: unknown) => void;

/** Append every declared optional profile + its env knobs. Throws on a
 *  malformed belt_model upstream (render fails loud, never half-declared). */
export function pushProfileEnv(hub: HubProfile, kv: EnvSink): void {
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
	// W2779.5: `mode: "fk"` retargets the sink at the public fleet-knowledge
	// repo (git-pulled at the knowledge_version pin) — the fk services ride
	// their OWN `knowledge-fk` profile so exactly one sink family runs per
	// hub (both default to :7802/:7803 — starting both is a port conflict).
	if (hub.knowledge) {
		profiles.push(hub.knowledge.mode === "fk" ? "knowledge-fk" : "knowledge");
		kv("HUB_KNOWLEDGE_SINK_PORT", hub.knowledge.port);
		kv("HUB_KNOWLEDGE_SINK_HEALTH_PORT", hub.knowledge.health_port);
		if (hub.knowledge.mode) {
			kv("HUB_KNOWLEDGE_MODE", hub.knowledge.mode);
			kv("HUB_KNOWLEDGE_VERSION", hub.knowledge.version);
			// the 0600 fk conf staged beside the compose (mounted ro at the
			// fixed container path; FLEET_KNOWLEDGE_CONFIG inside)
			if (hub.knowledge.conf) kv("HUB_KNOWLEDGE_CONF", hub.knowledge.conf);
			kv("HUB_KNOWLEDGE_BIND", hub.knowledge.bind);
		}
	}
	// W2595: litellm behind every buckle — declaring `litellm:` enables the
	// profile (engine container + health sidecar); the operator-maintained
	// 0600 litellm.yaml + copilot token cache sit beside the compose dir.
	if (hub.litellm) {
		profiles.push("litellm");
		kv("HUB_LITELLM_PORT", hub.litellm.port);
		kv("HUB_LITELLM_HEALTH_PORT", hub.litellm.health_port);
	}
	// W2329: the dataplane face — declaring `dataplane:` enables the profile
	// (dataplane-api container + its health probe sidecar, knowledge-sink
	// pattern); own port, never the LLM gateway front door.
	if (hub.dataplane) {
		profiles.push("dataplane");
		kv("HUB_DATAPLANE_PORT", hub.dataplane.port);
		kv("HUB_DATAPLANE_HEALTH_PORT", hub.dataplane.health_port);
	}
	if (profiles.length > 0) kv("COMPOSE_PROFILES", profiles.join(","));
}
