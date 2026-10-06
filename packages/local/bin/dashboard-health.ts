/** A network observation, not an assertion about application readiness. */
export type HealthObservation = {
	ok: boolean;
	reachable: boolean;
	code?: number;
	ms: number;
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
): Promise<HealthObservation> {
	const start = performance.now();
	try {
		const response = await fetch(`http://${target}${path}`, {
			signal: AbortSignal.timeout(timeout),
			redirect: "manual",
		});
		await response.body?.cancel();
		return {
			ok: response.ok,
			reachable: true,
			code: response.status,
			ms: Math.round(performance.now() - start),
		};
	} catch {
		return {
			ok: false,
			reachable: false,
			ms: Math.round(performance.now() - start),
		};
	}
}
