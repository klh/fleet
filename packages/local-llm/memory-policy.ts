import { totalmem } from "node:os";

export const wiredGuardGb = (value: string | undefined): number => {
	const parsed = Number(value);
	return value?.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
};

export const coldLoadTimeoutMs = (weightsGb: number): number =>
	Math.max(90_000, weightsGb * 20_000);

/** Per-engine Metal budget includes weights and KV, rather than all host RAM. */
export const modelBudgetGb = (weightsGb: number): number =>
	Math.min(40, Math.ceil(weightsGb * 1.2 + 4));

export function rapidMemoryArgs(
	weightsGb: number,
	hostBytes = totalmem(),
): string[] {
	const fraction = Math.min(
		0.5,
		(modelBudgetGb(weightsGb) * 2 ** 30) / hostBytes,
	);
	return [
		"--gpu-memory-utilization",
		String(fraction),
		"--cache-memory-mb",
		"1024",
		"--max-num-seqs",
		"2",
		"--max-concurrent-requests",
		"2",
		"--idle-cache-clear-seconds",
		"60",
		"--idle-unload-seconds",
		"900",
	];
}
