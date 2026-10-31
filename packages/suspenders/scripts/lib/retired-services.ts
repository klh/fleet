// lib/retired-services.ts — W2339: which launchd labels the watchdog must
// STOP auditing. The activation receipt records explicit install-time intent
// and deliberately retains entries a later manifest retired
// (retainActivation), so a receipt read on its own keeps auditing launchd
// labels that no longer exist — the W779 heartbeat fold left 11 such ghosts
// and the watchdog re-carded "recorded unit unavailable" for each on every
// 5-minute pass (13 NEED_DECISIONs per pass, 2026-10-31).
//
// Retirement has TWO truth sources, both current-code (the activated
// generation the watchdog itself runs from):
//   1. deploy/services.yaml legacyLabels — labels the installer boots out at
//      the next install --with-launchd (loadLegacyLabels).
//   2. MAINTENANCE_TASKS — the W779 fleet-loop task registry: a folded
//      maintenance agent is a typed heartbeat task now, supervised by the
//      loop's cycle watchdog, never by launchd.
// Their pairing is law-guaranteed by test/maintenance-legacy-drift.test.ts
// (W1256.1): every folded task name is covered by exactly one legacy label,
// every com.suspenders.* legacy label names a folded task or a documented
// retiree, and no task name collides with a live services.yaml unit. A label
// in either source is retired from the audit universe — permanently; the
// receipt keeping the ghost is intent history, not supervision truth.
// A manifest that fails to parse degrades to the task-derived set alone
// (lookup failure is never death), never to an empty set.
import { MAINTENANCE_TASKS } from "../../hooks/lib/fleet-loop/maintenance.ts";
import { loadLegacyLabels, MANIFEST_PATH } from "../install/install-services.ts";

/** Labels retired from launchd supervision: manifest legacyLabels ∪ the
 *  W779 heartbeat task registry, rendered as launchd label form. An
 *  undefined path (activated generation unavailable) falls back to the
 *  repo-shipped manifest, then to the task-derived set alone. */
export function retiredServiceLabels(
	manifestPath: string | undefined = MANIFEST_PATH,
): Set<string> {
	const retired = new Set<string>(
		MAINTENANCE_TASKS.map((task) => `com.suspenders.${task.name}`),
	);
	try {
		if (manifestPath !== undefined) {
			for (const label of loadLegacyLabels(manifestPath)) retired.add(label);
		}
	} catch {
		// unreadable/invalid manifest — task-derived retirement still holds
	}
	return retired;
}

/** Split receipt verdicts into the audit universe and retired ghosts.
 *  Order-preserving; a ghost is any verdict whose label is retired. */
export function splitRetiredVerdicts<T extends { label: string }>(
	verdicts: T[],
	retired: Set<string>,
): { audited: T[]; retiredGhosts: T[] } {
	const audited: T[] = [];
	const retiredGhosts: T[] = [];
	for (const verdict of verdicts) {
		if (retired.has(verdict.label)) retiredGhosts.push(verdict);
		else audited.push(verdict);
	}
	return { audited, retiredGhosts };
}
