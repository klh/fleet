// dispatch-hold-cli.ts — `dispatch hold` / `dispatch release` (W1196): holds
// are set through the CLI with attribution, never by touching files. An
// anonymous hold is refused: --reason is required, and --by defaults to the
// lane sid (SUSPENDERS_SID) or operator@host. The bare dispatch-paused
// marker has no CLI — release clears both shapes; log evidence accrues in
// .fleet/dispatch-hold.log.
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
	type DispatchHold,
	dispatchHoldActive,
	HOLD_TTL_HOURS_DEFAULT,
	holdExpiresAt,
	releaseHold,
	setHold,
} from "../../hooks/lib/lanes/dispatch-hold.ts";

export interface HoldDoorOpts {
	fleet: string;
	/** `dispatch release` pre-sets the release branch of the one hold verb. */
	release?: boolean;
}

const val = (argv: string[], flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};

const usage = (): string[] => [
	"Usage: dispatch hold --reason <why> [--ttl-hours N] [--by <who>]",
	"                      [--fleet <dir>]",
	"       dispatch release [--by <who>] [--fleet <dir>]",
	"",
	"Set or lift the dispatch hold. A hold is recorded state",
	"(.fleet/dispatch-paused.json: by, reason, set_at, ttl_hours), never a",
	"bare marker: every set/release lands in .fleet/dispatch-hold.log, the",
	"board shows by+reason+expiry, and an expired hold auto-lifts and logs.",
	`Default ttl is ${HOLD_TTL_HOURS_DEFAULT}h; the bare dispatch-paused marker is deprecated`,
	"(still held, logged as a deprecation on observe).",
	"",
	"--fleet <dir> redirects the door's writes to that dir (default: the",
	"canonical checkout's .fleet); a redirected hold/release names the dir in",
	"its output — smoke tests never touch live dispatch (W1235).",
];

/** Embedded main: the dispatch door owns argv and exit codes (W651). */
export const holdMain = (argv: string[], opts: HoldDoorOpts): number => {
	if (argv.includes("--help") || argv.includes("-h")) {
		for (const line of usage()) console.log(line);
		return 0;
	}
	// W1235: --fleet <dir> redirects the door's writes off the canonical .fleet
	// (the smoke-hold lesson — a worktree invocation must never throttle live
	// dispatch). Absent flag keeps opts.fleet; a valueless flag refuses.
	const fleetPath = val(argv, "--fleet");
	if (argv.includes("--fleet") && (fleetPath?.startsWith("--") ?? true)) {
		console.log("REFUSED — --fleet needs a directory path");
		return 2;
	}
	const fleetDir = fleetPath === undefined ? opts.fleet : resolve(fleetPath);
	const overridden = fleetPath !== undefined;
	const where = (): string => (overridden ? ` — fleet ${fleetDir}` : "");
	const by =
		val(argv, "--by") ?? process.env.SUSPENDERS_SID ?? `operator@${hostname()}`;
	if (opts.release) {
		const lifted = releaseHold(fleetDir, by);
		console.log(
			lifted
				? `RELEASED — dispatch hold lifted by ${by}${where()}`
				: "no active dispatch hold",
		);
		return lifted ? 0 : 1;
	}
	const reason = val(argv, "--reason");
	if (!reason) {
		console.log("REFUSED — an anonymous hold is not a hold: pass --reason");
		return 2;
	}
	const rawTtl = val(argv, "--ttl-hours");
	const ttl =
		rawTtl === undefined || rawTtl.length === 0
			? HOLD_TTL_HOURS_DEFAULT
			: Number(rawTtl);
	if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 24 * 30) {
		console.log("REFUSED — --ttl-hours must be 0 < ttl <= 720");
		return 2;
	}
	const hold: DispatchHold = setHold(fleetDir, by, reason, ttl);
	console.log(
		`HOLD — dispatch paused by ${hold.by} until ${holdExpiresAt(hold)} (${hold.ttl_hours}h): ${hold.reason}${where()}`,
	);
	return 0;
};

/** Show the active hold (board-parity view for the operator). */
export const holdStatus = (fleet: string): string => {
	const obs = dispatchHoldActive(fleet);
	if (!obs) return "no active dispatch hold";
	if (obs.legacy) {
		return "hold: legacy bare marker (deprecated) — no attribution, no expiry";
	}
	return `hold: by ${obs.hold.by} · set ${obs.hold.set_at} · ttl ${obs.hold.ttl_hours}h · expires ${holdExpiresAt(obs.hold)} · ${obs.hold.reason}`;
};
