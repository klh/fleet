// lib/watchdog-state.ts — the watchdog run-record boundary: persist the run's
// state file and return the aggregate verdict's exit code. Observation alone
// never increments restart counts — the record carries no restart bookkeeping
// and performs no service restart (W1271: behaviorized from the grep tests).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProgressState } from "./fleet-progress.ts";
import type { ResourceAction } from "./resource-actuator.ts";
import type { watchdogVerdict } from "./watchdog-verdict.ts";

export type WatchdogStateRecord = ProgressState & {
	loopPid: number | null;
	serviceFingerprints?: Record<string, string>;
	serviceCheckAt?: number;
	decisionEmits?: Record<string, number>;
	at: string;
	health: ReturnType<typeof watchdogVerdict>;
	resourceActions: ResourceAction[];
};

export const persistWatchdogState = (
	statePath: string,
	record: WatchdogStateRecord,
): number => {
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, JSON.stringify(record));
	return record.health.exitCode;
};
