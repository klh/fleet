// hooks/lib/fleet-loop/loop-config-watch.ts — W2242: the dedicated
// lightweight watcher that hot-applies the fleet_loop block of the machine
// stack conf (~/.config/klh/stack.json) without a launchd reload. Cheap
// mtime+size stat on a default-10s interval (unref'd — never holds the
// process open); the full JSON.parse + zod resolve runs ONLY on a detected
// change. CLI flags stay explicit one-shot overrides and never observe the
// watcher (they won the process start); the watcher owns live state only.
import { readFileSync, statSync } from "node:fs";
import {
	FLEET_LOOP_DEFAULTS,
	FleetLoopConfigSchema,
	fleetLoopSettings,
	type FleetLoopSettings,
} from "../stack-config.ts";

export interface LoopConfigWatch {
	/** current live settings (hot-applied) */
	settings: () => FleetLoopSettings;
	/** stop polling (tests) */
	stop: () => void;
}

interface ConfStamp {
	mtimeMs: number;
	size: number;
}

const stamp = (path: string): ConfStamp | null => {
	try {
		const s = statSync(path);
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return null;
	}
};

/** Read + resolve the fleet_loop block FROM THE WATCHED PATH (JSON.parse —
 *  W1253 Amendment A, the ONE parser; zod validates after parse). Null on
 *  a missing/malformed conf — the caller keeps the previous settings
 *  (config-over-code never crashes or resets the daemon mid-flight). */
const readSettings = (path: string): FleetLoopSettings | null => {
	try {
		// the fleet_loop block validates on its own (the whole-conf schema
		// requires hubs — a bare block-only test conf is still valid here)
		const parsed = FleetLoopConfigSchema.safeParse(
			JSON.parse(readFileSync(path, "utf8")).fleet_loop,
		);
		return parsed.success
			? fleetLoopSettings({ fleet_loop: parsed.data })
			: null;
	} catch {
		return null;
	}
};

/** Create the watcher. `path` defaults to the machine stack conf path via
 *  fleetLoopSettings' own resolution — explicit here so stat and parse
 *  observe the same file (KLH_STACK override honored by callers). */
export function createLoopConfigWatch(opts: {
	path: string;
	intervalMs?: number;
	log?: (line: string) => void;
}): LoopConfigWatch {
	const { path, intervalMs = 10_000, log = () => {} } = opts;
	let current: FleetLoopSettings = readSettings(path) ?? {
		...FLEET_LOOP_DEFAULTS,
	};
	let last: ConfStamp | null = stamp(path);
	const timer = setInterval(() => {
		const now = stamp(path);
		if (now === null || last === null) {
			// appeared or vanished — re-read either way when present
			if (now !== null) {
				last = now;
				apply(path);
			} else {
				last = null;
			}
			return;
		}
		if (now.mtimeMs !== last.mtimeMs || now.size !== last.size) {
			last = now;
			apply(path);
		}
	}, intervalMs);
	timer.unref?.();
	const apply = (p: string): void => {
		const next = readSettings(p);
		if (next === null) return; // malformed — previous settings stand
		const before = current;
		current = next;
		// W2351: the reviewer rows ride the same hot-apply (unset renders `-`)
		if (
			before.laneTarget !== current.laneTarget ||
			before.everyS !== current.everyS ||
			before.dispatchTarget !== current.dispatchTarget ||
			before.reviewFallbackModels !== current.reviewFallbackModels ||
			before.reviewStepdownClasses !== current.reviewStepdownClasses
		) {
			log(
				`LOOP-CONFIG hot-applied lane_target=${current.laneTarget} dispatch_target=${current.dispatchTarget} every_s=${current.everyS} review_fallback_models=${current.reviewFallbackModels ?? "-"} review_stepdown_classes=${current.reviewStepdownClasses ?? "-"}`,
			);
		}
	};
	return {
		settings: () => current,
		stop: () => clearInterval(timer),
	};
}
