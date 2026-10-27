import type { Deployment } from "./upstreams.ts";

export interface ServedIdentity {
	model: string | null;
	provider: string | null;
	providerProfile: string | null;
	evidence: "peer" | "configured" | "unknown";
}

const bounded = (value: unknown, model = false): string | null =>
	typeof value === "string" &&
	(model ? /^[\w][\w./:@+-]{0,255}$/ : /^\w[\w.-]{0,127}$/).test(value)
		? value
		: null;

export function requestedEffort(body: Record<string, unknown>): string | null {
	const config = body.output_config;
	const raw =
		(config && typeof config === "object"
			? (config as Record<string, unknown>).effort
			: undefined) ?? body.reasoning_effort;
	return typeof raw === "string" &&
		[
			"none",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultra",
		].includes(raw)
		? raw
		: null;
}

/** Only an explicitly configured, authenticated Buckle peer is authoritative
 * for its delivered route. Client headers and wire dialect never name a provider. */
export function servedIdentity(
	dep: Deployment,
	upstream: Headers,
): ServedIdentity {
	const peerModel = dep.buckle
		? bounded(upstream.get("x-klh-served-model"), true)
		: null;
	return {
		model: peerModel ?? bounded(dep.model, true),
		provider:
			(dep.buckle ? bounded(upstream.get("x-klh-served-provider")) : null) ??
			bounded(dep.provider),
		providerProfile:
			(dep.buckle
				? bounded(upstream.get("x-klh-served-provider-profile"))
				: null) ?? bounded(dep.providerProfile),
		evidence: peerModel
			? "peer"
			: bounded(dep.model, true)
				? "configured"
				: "unknown",
	};
}

export function stampServedIdentity(
	headers: Headers,
	identity: ServedIdentity,
): void {
	for (const [name, value] of [
		["x-klh-served-model", identity.model],
		["x-klh-served-provider", identity.provider],
		["x-klh-served-provider-profile", identity.providerProfile],
	] as const) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
}
