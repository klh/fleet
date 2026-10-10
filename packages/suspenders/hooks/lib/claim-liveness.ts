// claim-liveness.ts — W613: the reclaim verdict engine for the shared work
// graph. Two rules from the harness lift (docs/harness-lift-research.md #2):
//   • LOCAL EVIDENCE IS EXECUTOR-SCOPED. pid/transcript/worktree probes say
//     nothing about a lane on another machine ("reclaim belongs to the
//     granting replica" — beads). A claim is reclaimed on local evidence only
//     when its `take --origin` stamp is this executor's; claims granted
//     elsewhere expire by STORE heartbeat age, grace ≥ 2× the hb interval
//     (Hermes: other hosts' claims expire only through heartbeat age).
//   • TRI-STATE, NEVER NUDE ONCE. The probe returns live/dead/unknown; unknown
//     never releases ("never nudge on 'we cannot tell'" — Gas City), and dead
//     must repeat DEAD_REQUIRED consecutive sweeps (streak persisted in the
//     shared store, so passes accumulate across machines and operators).
import type { GovernorStore } from "./govdb.ts";
import {
	HB_GRACE_MS,
	type LaneRef,
	type LaneVerdict,
	laneVerdict,
	originIsLocal,
} from "./lane-liveness.ts";
import { releaseWorkClaim } from "./work-release.ts";

export const DEAD_REQUIRED = 3;

type ClaimRow = {
	id: string;
	owner_sid: string | null;
	origin: string | null;
	state: string;
	updated_at: number;
};

export type ClaimVerdict = {
	id: string;
	owner: string | null;
	origin: string | null;
	verdict: LaneVerdict | "extended";
	streak: number;
	action: "released" | "held";
	why: string;
};

export type SweepOpts = {
	now?: number;
	graceMs?: number;
	deadRequired?: number;
	/** store heartbeat age for an owner sid; null = no hb row (unknown). */
	hbAge?: (sid: string) => number | null;
	/** tri-state probe override (tests, alternate probes). */
	probe?: (l: LaneRef) => LaneVerdict;
	/** registry lane lookup for local pid/worktree evidence. */
	lane?: (sid: string) => LaneRef | null;
	/** CAS release; default releaseWorkClaim(by reclaim-all). */
	release?: (claim: {
		id: string;
		owner: string | null;
		state: string;
		updatedAt: number;
	}) => boolean;
};

export function claimLivenessTables(store: GovernorStore): void {
	store.run(
		"CREATE TABLE IF NOT EXISTS claim_extends (project TEXT NOT NULL, id TEXT NOT NULL, until_ms INTEGER NOT NULL, note TEXT, by_sid TEXT, at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	store.run(
		"CREATE TABLE IF NOT EXISTS claim_death_streaks (project TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, streak INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
}

/** "45m" | "90s" | "2h" → ms; null when not a clean magnitude+unit. */
export function parseForMs(v: string | undefined): number | null {
	const m = /^(\d+)([smh])$/.exec((v ?? "").trim());
	if (!m) return null;
	const n = Number(m[1]);
	const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
	return n * unit;
}

type ExtendInput = {
	project: string;
	id: string;
	sid: string | null; // owner check; null = operator extend, no ownership proof
	forMs: number;
	note?: string | null;
};

/** Pre-extend a live claim across a known-long operation (Hermes heartbeat
 * pre-extend): CAS on the claim's owner/state, recorded as an event. */
export function extendClaim(
	store: GovernorStore,
	input: ExtendInput,
): { ok: boolean; why: string; until: number } {
	claimLivenessTables(store);
	const now = Date.now();
	const reject = (why: string) => ({ ok: false, why, until: 0 });
	return store.transaction(() => {
		const until = now + input.forMs;
		const it = store
			.query(
				"SELECT owner_sid, state FROM work_items WHERE project = ? AND id = ?",
			)
			.get(input.project, input.id) as {
			owner_sid: string | null;
			state: string;
		} | null;
		if (!it) return reject(`no such item: ${input.id}`);
		if (!["CLAIMED", "RUNNING"].includes(it.state))
			return reject(`${input.id} is ${it.state} — nothing to extend`);
		if (input.sid && it.owner_sid !== input.sid)
			return reject(
				`${input.id} is claimed by ${String(it.owner_sid).slice(0, 8)} — not yours`,
			);
		store.run(
			"INSERT INTO claim_extends (project, id, until_ms, note, by_sid, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project, id) DO UPDATE SET until_ms = excluded.until_ms, note = excluded.note, by_sid = excluded.by_sid, at = excluded.at",
			input.project,
			input.id,
			until,
			input.note ?? null,
			input.sid,
			now,
		);
		store
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,'work','work.extended',?,?,NULL)",
			)
			.run(
				now,
				input.project,
				JSON.stringify({
					work: input.id,
					project: input.project,
					until,
					note: input.note ?? null,
					by: input.sid,
				}),
			);
		return { ok: true, why: "", until };
	})();
}

/** The tri-state observation for one claim, executor-scoped (W613): local
 * evidence only for this executor's own grants; everything else judges by
 * store-heartbeat age, never local proof. Extended claims hold outright. */
export function observeClaim(
	store: GovernorStore,
	project: string,
	r: ClaimRow,
	opts: SweepOpts,
	now: number,
): LaneVerdict | "extended" {
	let ext: { until_ms: number } | null = null;
	try {
		ext = store
			.query("SELECT until_ms FROM claim_extends WHERE project = ? AND id = ?")
			.get(project, r.id) as { until_ms: number } | null;
	} catch {} // table not minted yet — no extension on record
	if (ext && Number(ext.until_ms) > now) return "extended";
	if (originIsLocal(r.origin)) {
		// granting executor = this one: local evidence is admissible
		const ref = opts.lane?.(String(r.owner_sid)) ?? {
			sid: String(r.owner_sid),
			item: r.id,
		};
		return opts.probe ? opts.probe(ref) : laneVerdict(ref);
	}
	// foreign (or legacy unstamped) grant: heartbeat age in the STORE,
	// never local evidence — their transcripts are not this machine's
	const age =
		opts.hbAge?.(String(r.owner_sid)) ??
		defaultHbAge(store, String(r.owner_sid), now);
	return age === null || !Number.isFinite(age)
		? "unknown"
		: age <= (opts.graceMs ?? HB_GRACE_MS)
			? "live"
			: "dead";
}

function defaultHbAge(
	store: GovernorStore,
	sid: string,
	now: number,
): number | null {
	const row = store.query("SELECT hb FROM sessions WHERE sid = ?").get(sid) as {
		hb: number;
	} | null;
	return row ? now - Number(row.hb) : null;
}

/** Streak accounting + gated release for one observed verdict (W613): live
 * resets, unknown holds and RESETS (dead must be consecutive), dead increments
 * and releases only at DEAD_REQUIRED via the CAS release (claim-changed races
 * read as held). */
export function applyVerdict(
	store: GovernorStore,
	project: string,
	r: ClaimRow,
	verdict: LaneVerdict | "extended",
	deadRequired: number,
	opts: SweepOpts,
): ClaimVerdict {
	const base = { id: r.id, owner: r.owner_sid, origin: r.origin };
	if (verdict === "live" || verdict === "extended") {
		clearStreak(store, project, r.id);
		const why =
			verdict === "live" ? "lane live" : "claim extended (work extend)";
		return { ...base, verdict, streak: 0, action: "held", why };
	}
	if (verdict === "unknown") {
		clearStreak(store, project, r.id); // dead must be CONSECUTIVE
		return {
			...base,
			verdict,
			streak: 0,
			action: "held",
			why: "cannot tell — unknown never releases",
		};
	}
	const streak = bumpStreak(store, project, r.id, r.owner_sid);
	const release = opts.release ?? defaultRelease(store, project);
	const released =
		streak >= deadRequired &&
		release({
			id: r.id,
			owner: r.owner_sid,
			state: r.state,
			updatedAt: r.updated_at,
		});
	if (released) {
		clearStreak(store, project, r.id);
		return {
			...base,
			verdict,
			streak,
			action: "released",
			why: `dead ×${streak} consecutive`,
		};
	}
	return {
		...base,
		verdict,
		streak,
		action: "held",
		why: `dead ×${streak} — ${deadRequired - streak} more confirming sweep(s)`,
	};
}

function bumpStreak(
	store: GovernorStore,
	project: string,
	id: string,
	owner: string | null,
): number {
	store.run(
		"INSERT INTO claim_death_streaks (project, id, owner, streak, at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(project, id) DO UPDATE SET streak = streak + 1, owner = excluded.owner, at = excluded.at",
		project,
		id,
		owner ?? "",
		Date.now(),
	);
	const row = store
		.query(
			"SELECT streak FROM claim_death_streaks WHERE project = ? AND id = ?",
		)
		.get(project, id) as { streak: number } | null;
	return row?.streak ?? 1;
}

function clearStreak(store: GovernorStore, project: string, id: string): void {
	store.run(
		"DELETE FROM claim_death_streaks WHERE project = ? AND id = ?",
		project,
		id,
	);
}

function defaultRelease(store: GovernorStore, project: string) {
	return (claim: {
		id: string;
		owner: string | null;
		state: string;
		updatedAt: number;
	}): boolean =>
		releaseWorkClaim(
			store,
			{ project, ...claim },
			{ by: "reclaim-all", reason: "reclaim-all" },
		);
}

/** One reclaim-all pass over every CLAIMED/RUNNING claim of `project`:
 * observe → streak → (maybe) release. Line-per-item output is the caller's. */
export function sweepReclaims(
	store: GovernorStore,
	project: string,
	opts: SweepOpts = {},
): ClaimVerdict[] {
	claimLivenessTables(store);
	const now = opts.now ?? Date.now();
	const deadRequired = opts.deadRequired ?? DEAD_REQUIRED;
	const rows = store
		.query(
			"SELECT id, owner_sid, origin, state, updated_at FROM work_items WHERE project = ? AND state IN ('CLAIMED','RUNNING') ORDER BY id",
		)
		.all(project) as ClaimRow[];
	return rows.map((r) =>
		applyVerdict(
			store,
			project,
			r,
			observeClaim(store, project, r, opts, now),
			deadRequired,
			opts,
		),
	);
}
