// Independent cloud transport lifecycle: never starts the router or MLX swarm.
import { litellmTarget } from "./litellm-target.ts";
import type { Target } from "./supervisor.ts";

type Signals = Pick<NodeJS.Process, "on" | "off">;
export async function runCloudGateway(
	target: Target = litellmTarget(),
	signals: Signals = process,
): Promise<number> {
	const failure = target.preflight?.();
	if (failure) throw new Error(failure);
	if (!target.spawn) throw new Error("Cloud gateway spawn unavailable");
	const child = target.spawn();
	let stopping = false;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		child.kill("SIGTERM");
		deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
	};
	signals.on("SIGTERM", stop);
	signals.on("SIGINT", stop);
	try {
		const code = await child.exited;
		return stopping ? 0 : typeof code === "number" ? code : 1;
	} finally {
		if (deadline) clearTimeout(deadline);
		signals.off("SIGTERM", stop);
		signals.off("SIGINT", stop);
	}
}

if (import.meta.main) {
	try {
		process.exit(await runCloudGateway());
	} catch (error) {
		console.error(`Cloud gateway startup failed: ${String(error)}`);
		process.exit(1);
	}
}
