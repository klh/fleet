import type { ServiceVerdict } from "./service-drift.ts";

export type HealthState = "ok" | "unknown" | "degraded" | "stalled";
export interface WatchdogDimension {
	name: "activation" | "services" | "progress" | "lane" | "memory";
	state: HealthState;
	detail: string;
}
export function watchdogVerdict(
	input: {
		activation: WatchdogDimension;
		services: ServiceVerdict[];
		requiredServices?: string[];
		progress: WatchdogDimension;
		lane: WatchdogDimension;
		memory: WatchdogDimension;
	},
	now = Date.now(),
) {
	const observedServices = [...input.services];
	for (const label of input.requiredServices ?? []) {
		if (!observedServices.some((service) => service.label === label))
			observedServices.push({
				label,
				state: "unknown",
				reason:
					"service absent from explicit activation provenance; process death not inferred",
				pid: null,
			});
	}
	const states = observedServices.map(
		(service): HealthState =>
			service.state === "running" || service.state === "scheduled-idle"
				? "ok"
				: service.state === "unknown" || service.state === "starting"
					? "unknown"
					: "degraded",
	);
	const services: WatchdogDimension = {
		name: "services",
		state: states.includes("degraded")
			? "degraded"
			: states.length === 0 || states.includes("unknown")
				? "unknown"
				: "ok",
		detail:
			observedServices
				.map(
					(service) => `${service.label}: ${service.state} — ${service.reason}`,
				)
				.join("; ") || "no activated services verified",
	};
	const dimensions = [
		input.activation,
		services,
		input.progress,
		input.lane,
		input.memory,
	];
	const state: HealthState = dimensions.some(
		(dimension) => dimension.state === "degraded",
	)
		? "degraded"
		: dimensions.some((dimension) => dimension.state === "stalled")
			? "stalled"
			: dimensions.some((dimension) => dimension.state === "unknown")
				? "unknown"
				: "ok";
	return {
		schema: "fleet.watchdog-verdict.v1",
		at: new Date(now).toISOString(),
		state,
		exitCode: state === "ok" ? 0 : 1,
		dimensions,
	};
}
