// reclaim-liveness.ts — W610: `work reclaim all` liveness parity. The bulk
// reaper stops trusting transcript mtime alone (a lane inside one >15-min
// tool call was reclaimable while alive) and shares the lane-liveness truth
// (laneVerdict: process identity + claimant transcript) plus the governor
// heartbeat (sessions.hb — advances with every gate touch, W9). Tri-state
// alive/dead/unknown; unknown NEVER releases (monitor doctrine W51: lookup
// failure is never death). W972: positive session absence — no session row,
// or closed row — IS death evidence when the claimant holds no lane-registry
// entry. A stale heartbeat alone is ambiguous for manual Codex claims:
// the active desktop turn may not touch the governor for over 45 minutes.
// Death must repeat N consecutive passes before a
// release — the counter lives in the facts table, reset by any non-dead pass
// or claim change (Gas City detached_probe lift, docs/harness-lift-research.md
// #2). A claimant can pause the reaper across a known-long op:
// `work extend <id> --for 45m` (Hermes claim-extend lift).
import type { GovernorStore } from "../govdb/govdb.ts";
import {
	type LaneRef,
	laneVerdict,
	type ProcessInspector,
} from "./lane-liveness.ts";

// sessions heartbeat window — bus parity with quota-sweep LIVE_HB_MS
const LIVE_HB_MS = 30 * 60_000;
// dead must repeat this many consecutive reclaim passes before release
export const STRIKES_TO_RECLAIM = 3;
// `work extend --for` ceiling — an extension is a pause, not a retirement
const MAX_EXTEND_MS = 24 * 60 * 60_000;

/** "45m" | "2h" | "90s" → ms; null on junk or past the 24h ceiling. */
export const parseDuration = (raw: string): number | null => {
	const m = raw.match(/^(\d+)([smh])$/);
	if (!m) return null;
	const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
	const ms = Number(m[1]) * unit;
	return ms > MAX_EXTEND_MS || ms <= 0 ? null : ms;
};

// only a RUNNING session vouches — close paths touch hb (quota-sweep doctrine)
export function hbFresh(
	store: GovernorStore,
	sid: string,
	now = Date.now(),
): boolean {
	try {
		const row = store
			.query("SELECT hb FROM sessions WHERE sid = ? AND state = 'RUNNING'")
			.get(sid) as { hb: number } | null;
		return !!row && row.hb > now - LIVE_HB_MS;
	} catch {
		return false;
	}
}

// W972: positive session-death evidence for the claim-liveness verdict.
// "No session + no lane entry" is death evidence, not lookup failure: a
// claim whose owning session is positively gone and whose lane-registry
// entry is pruned must be releasable. An open session with a stale heartbeat
// remains unknown: a Codex desktop turn can work without touching the
// governor, so stale time is not proof of death. Pid-reuse safety: this path
// reads NO process table — identity is the sid-keyed row itself, so a recycled pid
// can neither fake nor flip it; the registry path keeps its args-anchored
// process identity (laneProcessIdentity: the sid must appear in the harness
// argv), the start-time/boot-id class of anchor.
export type SessionDeath =
	| { dead: false; why: null }
	| { dead: true; why: string };

export function sessionDeathEvidence(
	store: GovernorStore,
	sid: string,
): SessionDeath | null {
	if (!sid) return null;
	try {
		const row = store
			.query("SELECT state FROM sessions WHERE sid = ?")
			.get(sid) as { state: string } | null;
		if (!row) return { dead: true, why: "no session row" };
		if (row.state !== "RUNNING") return { dead: true, why: "session closed" };
		return { dead: false, why: null };
	} catch {
		return null; // db error — lookup failure is never death (W51)
	}
}

export type ReclaimVerdict = "alive" | "dead" | "unknown";

export type ClaimProbe = {
	verdict: ReclaimVerdict;
	holdUntil: number | null;
	/** W972: when dead via positive session absence (no lane entry), the tag. */
	deathEvidence?: string;
};

export type ClaimObservation = {
	id: string;
	owner: string;
	revision: number;
	lane?: LaneRef;
	now?: number;
	/** W1072.3: injected ps roster (tests) — the recycled-pid bound rides it. */
	inspect?: ProcessInspector;
};

/** Read-only verdict — no counter writes, safe for listing surfaces. */
export function probeClaim(
	store: GovernorStore,
	project: string,
	obs: ClaimObservation,
): ClaimProbe {
	const now = obs.now ?? Date.now();
	const lease = readReclaimHold(store, project, obs.id);
	const holdUntil =
		lease && lease.holdUntil > now ? (lease.holdUntil as number) : null;
	let verdict: ReclaimVerdict = obs.lane
		? laneVerdict(obs.lane, obs.inspect)
		: "unknown";
	let deathEvidence: string | undefined;
	if (verdict !== "alive" && hbFresh(store, obs.owner, now)) verdict = "alive";
	// W972: positive absence on BOTH terms is death evidence, not lookup
	// failure — no lane-registry entry AND the owning session positively
	// gone (row gone / closed). Lookup failure (null) stays
	// unknown: W51, unknown never releases.
	if (verdict === "unknown" && !obs.lane) {
		const death = sessionDeathEvidence(store, obs.owner);
		if (death?.dead) {
			verdict = "dead";
			deathEvidence = `no lane entry + ${death.why}`;
		}
	}
	return deathEvidence
		? { verdict, holdUntil, deathEvidence }
		: { verdict, holdUntil };
}

export type ReclaimDecision = ClaimProbe & {
	strikes: number;
	action: "release" | "hold";
	why: string;
};

/** One reclaim pass over one claim: verdict + consecutive-strike accounting.
 * Alive/unknown clears the counter (the chain must be UNBROKEN); dead
 * increments it for the same owner+revision and releases at N. */
export function observeReclaim(
	store: GovernorStore,
	project: string,
	obs: ClaimObservation,
): ReclaimDecision {
	const now = obs.now ?? Date.now();
	const key = strikeKey(project, obs.id);
	const { verdict, holdUntil, deathEvidence } = probeClaim(store, project, obs);
	if (holdUntil !== null) {
		clearStrikes(store, key);
		return {
			verdict,
			strikes: 0,
			holdUntil,
			action: "hold",
			why: `reclaim held by extend lease (until ${new Date(holdUntil).toISOString()})`,
		};
	}
	if (verdict !== "dead") {
		clearStrikes(store, key); // unbroken-chain law: any non-dead pass resets
		return {
			verdict,
			strikes: 0,
			holdUntil,
			action: "hold",
			why:
				verdict === "unknown"
					? "unknown — no death evidence, reclaim all never releases it"
					: "live",
		};
	}
	const prev = readStrikes(store, key);
	const sameClaim =
		prev && prev.owner === obs.owner && prev.revision === obs.revision;
	const strikes = sameClaim ? prev.strikes + 1 : 1;
	store.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'work', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		key,
		JSON.stringify({ owner: obs.owner, revision: obs.revision, strikes }),
		now,
	);
	const tag = deathEvidence ? ` — ${deathEvidence}` : "";
	if (strikes >= STRIKES_TO_RECLAIM)
		return {
			verdict,
			strikes,
			holdUntil,
			action: "release",
			why: `dead${tag} ×${strikes} consecutive passes`,
		};
	return {
		verdict,
		strikes,
		holdUntil,
		action: "hold",
		why: `dead${tag}, strike ${strikes}/${STRIKES_TO_RECLAIM}`,
	};
}

/** `work extend` — hold the reaper off a claim until holdUntil (≤24h). */
export function setReclaimHold(
	store: GovernorStore,
	project: string,
	id: string,
	holdUntil: number,
	by: string,
): void {
	store.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'work', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		extendKey(project, id),
		JSON.stringify({ holdUntil, by }),
		Date.now(),
	);
}

/** Strike counter cleanup after a successful release. */
export function clearReclaimStrikes(
	store: GovernorStore,
	project: string,
	id: string,
): void {
	clearStrikes(store, strikeKey(project, id));
}

// ---- facts plumbing --------------------------------------------------------
// key is globally unique (facts PK) — project + item namespace it. The upsert
// mirrors govdb/work-completion-record (one shape, four call sites now).

const strikeKey = (project: string, id: string): string =>
	`reclaim.strike.${project}.${id}`;
const extendKey = (project: string, id: string): string =>
	`reclaim.extend.${project}.${id}`;

function clearStrikes(store: GovernorStore, key: string): void {
	try {
		store.run("DELETE FROM facts WHERE key = ?", key);
	} catch {}
}

function readStrikes(
	store: GovernorStore,
	key: string,
): { owner: string; revision: number; strikes: number } | null {
	try {
		const row = store
			.query("SELECT value FROM facts WHERE key = ?")
			.get(key) as { value: string } | null;
		if (!row) return null;
		const v = JSON.parse(row.value) as {
			owner?: unknown;
			revision?: unknown;
			strikes?: unknown;
		};
		if (
			typeof v.owner !== "string" ||
			typeof v.revision !== "number" ||
			typeof v.strikes !== "number" ||
			v.strikes < 1
		)
			return null;
		return { owner: v.owner, revision: v.revision, strikes: v.strikes };
	} catch {
		return null;
	}
}

function readReclaimHold(
	store: GovernorStore,
	project: string,
	id: string,
): { holdUntil: number; by?: string } | null {
	try {
		const row = store
			.query("SELECT value FROM facts WHERE key = ?")
			.get(extendKey(project, id)) as { value: string } | null;
		if (!row) return null;
		const v = JSON.parse(row.value) as { holdUntil?: unknown };
		return typeof v.holdUntil === "number" ? v : null;
	} catch {
		return null;
	}
}
