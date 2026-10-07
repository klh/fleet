import type { Observation } from "../lib/observation.ts";
import {
	onDemandIdleObservation,
	readSupervisorSnapshot,
} from "./supervisor-snapshot.ts";

export interface AdviceReadiness {
	ok: boolean;
	state: "up" | "idle" | "down" | "degraded";
	detail: string;
	observation?: Observation;
}

interface AdviceCheckDeps {
	fetch: typeof fetch;
	readSupervisor: () => unknown;
	now: () => number;
}

const defaults: AdviceCheckDeps = {
	fetch: (url, init) => fetch(url, init),
	readSupervisor: readSupervisorSnapshot,
	now: Date.now,
};

/** Advice shares the service console's independent on-demand lifecycle evidence. */
export async function adviceReadiness(
	origin: string,
	deps: AdviceCheckDeps = defaults,
): Promise<AdviceReadiness> {
	try {
		const response = await deps.fetch(`${origin}/v1/models`, {
			signal: AbortSignal.timeout(1500),
			redirect: "manual",
		});
		await response.body?.cancel();
		return {
			ok: response.ok,
			state: response.ok ? "up" : "degraded",
			detail: response.ok
				? `${origin} answers`
				: `HTTP ${response.status} from ${origin}`,
		};
	} catch {
		const endpoint = new URL(origin);
		// Supervisor observations are local; a remote port match is not evidence.
		const local = ["127.0.0.1", "localhost", "[::1]"].includes(
			endpoint.hostname,
		);
		const evidence = local
			? onDemandIdleObservation(
					deps.readSupervisor(),
					Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
					deps.now(),
				)
			: null;
		if (evidence)
			return {
				ok: false,
				state: "idle",
				detail: `${origin} is on demand and not loaded; advice becomes available when activated`,
				observation: evidence,
			};
		return {
			ok: false,
			state: "down",
			detail: `no answer from ${origin} within 1.5s`,
		};
	}
}
