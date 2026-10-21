import type { SpawnLedger } from "../../../belt/bin/spawn-admission.ts";
import {
	coldLoadTimeoutMs,
	wiredGuardGb,
} from "../../../local-llm/memory-policy.ts";

/** Emergency reaping starts above the admission ceiling, not at it. */
export const emergencyWiredLimitGb = (configured: string): number =>
	wiredGuardGb(configured) + 4;

export const loadingReservation = (
	port: number,
	pid: number,
	ledger: SpawnLedger,
	now = Date.now(),
): boolean => {
	const row = ledger[String(port)];
	return Boolean(
		row &&
			row.pid === pid &&
			Number.isFinite(row.startedAt) &&
			row.startedAt <= now &&
			now - row.startedAt < coldLoadTimeoutMs(row.ram_gb ?? 22) + 60_000,
	);
};
