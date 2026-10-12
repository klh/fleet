import { litellmTarget } from "./litellm-target.ts";

type GatewayTarget = ReturnType<typeof litellmTarget>;

/** Adopt a live gateway; supervise only children we spawned. Never start models. */
export function gatewaySupervisor(
	target: GatewayTarget = litellmTarget(),
	log: (message: string) => void = console.log,
	now: () => number = Date.now,
	probe: () => Promise<boolean> = async () => {
		try {
			const response = await fetch(
				`http://127.0.0.1:${target.port}${target.healthPath}`,
				{
					headers: target.probeHeaders?.(),
					signal: AbortSignal.timeout(2000),
					redirect: "manual",
				},
			);
			await response.body?.cancel();
			return target.okStatus?.includes(response.status) ?? response.ok;
		} catch {
			return false;
		}
	},
): () => Promise<void> {
	let child: ReturnType<NonNullable<GatewayTarget["spawn"]>> | undefined;
	let exited = true;
	let attempts = 0;
	let startedAt = 0;
	let misses = 0;
	return async () => {
		if (await probe()) {
			misses = 0;
			attempts = 0;
			return;
		}
		misses++;
		if (child && !exited) {
			if (now() - startedAt < (target.bindTimeoutMs ?? 120_000)) return;
			if (misses < 3) return;
			child.kill("SIGKILL");
			await child.exited;
			log(`gateway :${target.port} unresponsive; restarting owned child`);
		}
		const backoff = Math.min(300_000, 2000 * 2 ** Math.min(attempts, 8));
		if (attempts > 0 && now() - startedAt < backoff) return;
		startedAt = now();
		attempts++;
		try {
			const error = target.preflight?.();
			if (error) {
				log(`gateway :${target.port} preflight: ${error}`);
				return;
			}
			if (!target.spawn) throw new Error("gateway has no spawn function");
			child = target.spawn();
			exited = false;
			child.exited.then(() => {
				exited = true;
			});
			log(`gateway :${target.port} started pid ${child.pid}`);
		} catch {
			log(`gateway :${target.port} start failed; retry with backoff`);
		}
	};
}
