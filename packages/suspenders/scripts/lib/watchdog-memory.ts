import type { SpawnLedger } from "../../../belt/bin/spawn-admission.ts";
import { byPort } from "../../../belt/bin/registry.ts";
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
			// The ledger stores the admission budget, while the timeout uses
			// checkpoint weights. Unknown ports keep the budget as a conservative
			// upper bound so an unregistered active load is never reaped early.
			now - row.startedAt <
				coldLoadTimeoutMs(byPort(port)?.ram_gb ?? row.ram_gb ?? 40) + 60_000,
	);
};
