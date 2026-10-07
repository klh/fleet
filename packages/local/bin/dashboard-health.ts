import { observation, type Observation } from "./observation.ts";
import { endpointPassed } from "./health.ts";
/** A network observation, not an assertion about application readiness. */
export type HealthObservation = {
	ok: boolean;
	reachable: boolean;
	code?: number;
	ms: number;
	observation: Observation;
};

export function serviceTarget(service: {
	port: number;
	upstream?: string;
}): string {
	return service.upstream ?? `127.0.0.1:${service.port}`;
}

export async function probeService(
	target: string,
	path: string,
	timeout = 1500,
	virtualHost?: string,
): Promise<HealthObservation> {
	const start = performance.now();
	const evidence = () =>
		observation(
			"local-bar-network-probe",
			`http://${target}${path}`,
			"registered-service",
			Date.now(),
			10_000,
			"http-check",
		);
	try {
		const response = await fetch(`http://${target}${path}`, {
			headers: virtualHost ? { Host: virtualHost } : undefined,
			signal: AbortSignal.timeout(timeout),
			redirect: "manual",
		});
		const ok = await endpointPassed(response);
		return {
			ok,
			reachable: true,
			code: response.status,
			ms: Math.round(performance.now() - start),
			observation: evidence(),
		};
	} catch {
		return {
			ok: false,
			reachable: false,
			ms: Math.round(performance.now() - start),
			observation: evidence(),
		};
	}
}
