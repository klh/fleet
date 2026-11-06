// scripts/lib/rung-breaker.ts — W2786: the lane-launch circuit breaker.
// A (executor, model, hub) rung that keeps killing lanes at their FIRST API
// call (the W2783 shape: 10x 502 no_route into a quota-walled copilot rung)
// must stop being re-picked. After K consecutive classified launch-exits
// (rate-limit / upstream / transport) on the same rung, the rung cools for a
// window and the launch walk advances to the NEXT chain rung; the rung
// recovers on window expiry (a later attempt may re-prove it).
//
// State: facts rows `dispatch.rung-breaker.<hash>` (config-over-code; the
// store is the one home, no sidecar files). Recorded at the two seams that
// already classify failure text — launchFailureCatch (the launcher catch) and
// the resume re-arm tail classification — and cleared when a launch on the
// rung COMMITS (first success). Consulted by resolveLaunchPick (lane-launch)
// which wraps execPick's attempt walk: an open rung advances the attempt
// index past every tripped rung (bounded by chain length), preserving the
// owner-intent law (a .prefer MUST rung is skipped while tripped, never
// silently re-targeted — the skip note names it).
import type { GovernorStore } from "../../hooks/lib/govdb/govdb.ts";
import { classifyLaunchFailure } from "./launch-backoff.ts";

export const RUNG_BREAKER_PREFIX = "dispatch.rung-breaker.";

/** Failure classes that trip the breaker — the api_error/5xx/429 family the
 *  mission names. configuration launches never trip (retrying a DIFFERENT
 *  rung cannot fix a bad flag) and unknown stays out (no evidence). */
const TRIPPING_KINDS = new Set(["rate-limit", "upstream", "transport"]);

export const DEFAULT_RUNG_BREAKER_K = 2;
export const DEFAULT_RUNG_BREAKER_WINDOW_MS = 30 * 60_000;

export const rungBreakerK = (): number => {
	const raw = Number(process.env.SUSPENDERS_LANE_RUNG_BREAKER_K);
	return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_RUNG_BREAKER_K;
};

export const rungBreakerWindowMs = (): number => {
	const raw = Number(process.env.SUSPENDERS_LANE_RUNG_BREAKER_WINDOW_MS);
	return Number.isSafeInteger(raw) && raw > 0
		? raw
		: DEFAULT_RUNG_BREAKER_WINDOW_MS;
};

/** The rung identity a breaker state row is keyed on. `null` model/hub ride
 *  as "-" (unpinned executor slots share one rung per executor). */
export type RungKey = {
	executor: string;
	model: string | null;
	hub: string | null;
};

const rungId = (r: RungKey): string =>
	[r.executor, r.model ?? "-", r.hub ?? "-"].join("|");

const factKey = (r: RungKey): string =>
	`${RUNG_BREAKER_PREFIX}${Bun.hash(rungId(r)).toString(16)}`;

export type RungBreakerState = {
	rung: string;
	failures: number;
	firstAt: number;
	lastAt: number;
	/** epoch ms — the rung re-enters rotation at/after this */
	until: number;
	kind: string;
};

function readState(store: GovernorStore, r: RungKey): RungBreakerState | null {
	try {
		const row = store
			.query("SELECT value FROM facts WHERE key=?")
			.get(factKey(r)) as { value: string } | null;
		if (!row) return null;
		const v = JSON.parse(row.value) as RungBreakerState;
		return Number.isFinite(v.until) && Number.isFinite(v.failures) ? v : null;
	} catch {
		return null;
	}
}

function writeState(store: GovernorStore, s: RungBreakerState): void {
	store
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'dispatch',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts",
		)
		.run(factKeyOf(s), JSON.stringify(s), Date.now());
}

// factKey needs the full rung triple; writeState rebuilds it from the stored
// rung string (the row is only ever written with its own key).
function factKeyOf(s: RungBreakerState): string {
	const [executor, model, hub] = s.rung.split("|");
	return factKey({
		executor: executor ?? "",
		model: model === "-" || model === undefined ? null : model,
		hub: hub === "-" || hub === undefined ? null : hub,
	});
}

/** Is the rung currently open (cooling)? Expired rows read closed. */
export function rungOpen(
	store: GovernorStore,
	r: RungKey,
	now = Date.now(),
): RungBreakerState | null {
	const s = readState(store, r);
	if (!s) return null;
	return s.until > now ? s : null;
}

/** One classified failure on the rung. Returns the state AFTER the fold:
 *  consecutive failures < K just count; reaching K opens the window.
 *  `evidence` is the attempt-scoped appended log text (W1165) — an empty
 *  string (no evidence) never trips (unknown kind stays out). */
export function recordRungFailure(
	store: GovernorStore,
	r: RungKey,
	evidence: string,
	now = Date.now(),
	k = rungBreakerK(),
	windowMs = rungBreakerWindowMs(),
): RungBreakerState {
	const failure = classifyLaunchFailure(evidence, now);
	const prior = readState(store, r);
	// a stale open window from an old episode does not seed the count
	const fresh = prior && now - prior.lastAt < windowMs;
	const failures = TRIPPING_KINDS.has(failure.kind)
		? (fresh ? prior.failures : 0) + 1
		: fresh
			? prior.failures
			: 0;
	const state: RungBreakerState = {
		rung: rungId(r),
		failures,
		firstAt: fresh ? prior.firstAt : now,
		lastAt: now,
		until:
			failures >= k && TRIPPING_KINDS.has(failure.kind)
				? now + windowMs
				: fresh
					? prior.until
					: 0,
		kind: failure.kind,
	};
	writeState(store, state);
	return state;
}

/** A committed launch on the rung is the first success — the breaker
 *  resets (half-open: one healthy launch re-enters the rung). */
export function clearRung(store: GovernorStore, r: RungKey): void {
	try {
		store.query("DELETE FROM facts WHERE key=?").run(factKey(r));
	} catch {
		// a dark facts table never blocks launches
	}
}

/** The launch walk: starting at `attempt`'s pick, advance while the chosen
 *  rung's breaker is open. `pickAt` is execPick bound to the caller's chain
 *  context — it clamps at chain end (overrun parks on the last rung), so the
 *  walk ends when the pick stops changing. Every skip is surfaced through
 *  `note` — never a silent re-target. */
export function resolveLaunchPick<
	P extends {
		name: string;
		bin: string;
		model: string | null;
		hub: string | null;
	},
>(
	store: GovernorStore,
	pickAt: (index: number) => P,
	attempt: number,
	note: (msg: string) => void,
	now = Date.now(),
): P {
	let index = attempt;
	let pick = pickAt(index);
	for (let guard = 0; guard < 32; guard++) {
		const open = rungOpen(
			store,
			laneRungOf(pick.bin, pick.model, pick.hub),
			now,
		);
		if (!open) return pick;
		const next = pickAt(index + 1);
		if (
			next.name === pick.name &&
			next.model === pick.model &&
			next.hub === pick.hub
		)
			return pick; // chain end — overrun parks on the last rung
		note(
			`rung breaker: ${pick.name}${pick.model ? ` (${pick.model})` : ""} cooling — ${open.kind} x${open.failures} until ${new Date(open.until).toISOString()}; advancing to ${next.name}`,
		);
		pick = next;
		index++;
	}
	return pick;
}

/** The rung a lane actually launched on — the clear/record key callers use.
 *  hub normalizes to the resolved label when known. */
export const laneRungOf = (
	executor: string,
	model: string | null,
	hub: string | null | undefined,
): RungKey => ({
	executor,
	model,
	hub: hub ?? null,
});
