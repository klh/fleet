// W1196: a dispatch hold is NAMED, timestamped, TTL'd state — never an
// anonymous bare marker. Operators need holds, but an unowned infinite hold
// silently throttles a 31-lane fleet: the bare `.fleet/dispatch-paused`
// marker re-armed itself three times on 2026-10-21/22 with no record of WHO
// set it or WHEN it expires. One module owns the file format, the NDJSON
// audit log and the observe/expire decisions so fleet-loop, the dispatcher
// and the board read ONE shape and every writer lands here with attribution.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Hold mode (W2318, Kueue StopPolicy vocabulary): `hold` = the W1196 default
 * (new dispatch refuses, live lanes keep running untouched); `drain` =
 * HoldAndDrain — the fleet-loop additionally STEERS live lanes toward
 * checkpointing and landing, never killing (lanes are not checkpointable
 * mid-flight). Not an intent state: launch-fencing owns those.
 */
export const HOLD_MODES = ["hold", "drain"] as const;
export type HoldMode = (typeof HOLD_MODES)[number];

/** Schema law: the hold file is config a service consumes — zod is the parser. */
export const DispatchHoldSchema = z.object({
	by: z.string().min(1),
	reason: z.string().min(1),
	set_at: z.string(),
	ttl_hours: z.number().positive().finite(),
	mode: z.enum(HOLD_MODES).default("hold"),
});
export type DispatchHold = z.infer<typeof DispatchHoldSchema>;

/** One dispatch-hold observation for consumers (dispatcher, board payload). */
export interface HoldObservation {
	hold: DispatchHold;
	/** ms until auto-lift; `Infinity` for the legacy marker (no expiry). */
	remainingMs: number;
	/** True when the hold state is the deprecated bare marker. */
	legacy: boolean;
}

export const HOLD_FILE = "dispatch-paused.json";
export const HOLD_LOG = "dispatch-hold.log";
export const HOLD_TTL_HOURS_DEFAULT = 4;
const LEGACY_MARKER = "dispatch-paused";
const HOUR_MS = 3_600_000;

const holdPath = (fleetDir: string): string => join(fleetDir, HOLD_FILE);

/** NDJSON audit trail: set/release/expire/legacy-warn land here. */
const logHold = (fleetDir: string, row: Record<string, unknown>): void => {
	try {
		appendFileSync(
			join(fleetDir, HOLD_LOG),
			`${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`,
		);
	} catch {
		// a dark .fleet never blocks the dispatcher
	}
};

/** Parse + validate; a hold missing attribution or a real timestamp is not one. */
const parseHold = (raw: string): DispatchHold | null => {
	try {
		const j: unknown = JSON.parse(raw);
		const parsed = DispatchHoldSchema.safeParse(j);
		if (!parsed.success) return null;
		const at = Date.parse(parsed.data.set_at);
		if (!Number.isFinite(at)) return null;
		return { ...parsed.data, set_at: new Date(at).toISOString() };
	} catch {
		return null;
	}
};

/** ISO instant the hold auto-lifts (never called on a legacy observation). */
export const holdExpiresAt = (hold: DispatchHold): string =>
	new Date(Date.parse(hold.set_at) + hold.ttl_hours * HOUR_MS).toISOString();

/**
 * THE writer. Operators and fleet-loop alike go through here, so a hold can
 * never re-arm without a by/reason/record; a bare marker next to it is
 * retired (the recorded hold supersedes the anonymous relic).
 */
export const setHold = (
	fleetDir: string,
	by: string,
	reason: string,
	ttlHours: number = HOLD_TTL_HOURS_DEFAULT,
	mode: HoldMode = "hold",
): DispatchHold => {
	mkdirSync(fleetDir, { recursive: true });
	const hold: DispatchHold = {
		by,
		reason,
		set_at: new Date().toISOString(),
		ttl_hours: ttlHours,
		mode,
	};
	writeFileSync(holdPath(fleetDir), `${JSON.stringify(hold, null, "\t")}\n`);
	logHold(fleetDir, {
		kind: "hold.set",
		by,
		reason,
		ttl_hours: ttlHours,
		mode,
		expires_at: holdExpiresAt(hold),
	});
	rmSync(join(fleetDir, LEGACY_MARKER), { force: true });
	return hold;
};

/** Lift the hold (recorded or legacy relic); returns true when one existed. */
export const releaseHold = (fleetDir: string, by: string): boolean => {
	const had =
		existsSync(holdPath(fleetDir)) || existsSync(join(fleetDir, LEGACY_MARKER));
	if (!had) return false;
	rmSync(holdPath(fleetDir), { force: true });
	rmSync(join(fleetDir, LEGACY_MARKER), { force: true });
	logHold(fleetDir, { kind: "hold.release", by });
	return true;
};

/**
 * Observe the hold: an expired hold auto-lifts and logs at read time (there
 * is no daemon to wait for), a corrupt file is dropped and logged, and the
 * deprecated bare marker still holds — with `legacy: true` so callers warn.
 */
export const dispatchHoldActive = (
	fleetDir: string,
	now = Date.now(),
): HoldObservation | null => {
	const path = holdPath(fleetDir);
	if (existsSync(path)) {
		const hold = parseHold(readFileSync(path, "utf8"));
		if (hold) {
			const remainingMs =
				Date.parse(hold.set_at) + hold.ttl_hours * HOUR_MS - now;
			if (remainingMs <= 0) {
				rmSync(path, { force: true });
				logHold(fleetDir, {
					kind: "hold.expire",
					by: hold.by,
					reason: hold.reason,
				});
				return null;
			}
			return { hold, remainingMs, legacy: false };
		}
		rmSync(path, { force: true });
		logHold(fleetDir, { kind: "hold.corrupt" });
	}
	if (existsSync(join(fleetDir, LEGACY_MARKER))) {
		return {
			hold: {
				by: "(legacy marker)",
				reason: "bare dispatch-paused file — no attribution, no expiry",
				set_at: "",
				ttl_hours: 0,
			},
			remainingMs: Number.POSITIVE_INFINITY,
			legacy: true,
		};
	}
	return null;
};

/** The coordinator-facing WAIT verdict: the line names WHO holds and UNTIL WHEN. */
export const dispatchHoldGate = (fleetDir: string): string | null => {
	const obs = dispatchHoldActive(fleetDir);
	if (!obs) return null;
	if (obs.legacy) {
		logHold(fleetDir, { kind: "hold.legacy-warn" });
		return 'WAIT — dispatch paused by a bare .fleet/dispatch-paused marker (deprecated: no attribution, no expiry) — set a recorded hold: dispatch hold --reason "..."';
	}
	const minutes = Math.max(0, Math.round(obs.remainingMs / 60_000));
	if (obs.hold.mode === "drain")
		return `WAIT — dispatch draining by ${obs.hold.by} for ${minutes} more min (set ${obs.hold.set_at}, ttl ${obs.hold.ttl_hours}h): ${obs.hold.reason}; live lanes are steered to checkpoint and land, never killed`;
	return `WAIT — dispatch paused by ${obs.hold.by} for ${minutes} more min (set ${obs.hold.set_at}, ttl ${obs.hold.ttl_hours}h): ${obs.hold.reason}; live lanes keep running`;
};

/** Board payload rows: one row per project that currently holds dispatch. */
export interface DispatchHoldRow {
	project: string;
	by: string;
	reason: string;
	set_at: string;
	expires_at: string | null;
	remaining_min: number | null;
	legacy: boolean;
	mode: HoldMode;
}

export const dispatchHoldRows = (
	projects: { project: string }[],
	now = Date.now(),
): DispatchHoldRow[] => {
	const rows: DispatchHoldRow[] = [];
	for (const { project } of projects) {
		const obs = dispatchHoldActive(join(project, ".fleet"), now);
		if (!obs) continue;
		rows.push({
			project,
			by: obs.hold.by,
			reason: obs.hold.reason,
			set_at: obs.hold.set_at,
			expires_at: obs.legacy ? null : holdExpiresAt(obs.hold),
			remaining_min: obs.legacy ? null : Math.round(obs.remainingMs / 60_000),
			legacy: obs.legacy,
			mode: obs.legacy ? "hold" : obs.hold.mode,
		});
	}
	return rows;
};
