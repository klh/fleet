import type { LaneRef } from "./lane-liveness.ts";
import type { GovernorStore } from "./govdb.ts";

export type DeadEpisode = {
	owner: string;
	revision: number;
	firstConfirmedDeadAt?: number;
	quarantined?: boolean;
	lastRecoveryResult?: "held" | "exhausted";
};
export type RecoveryObservation = {
	lane: LaneRef;
	localHost: string;
	owner: string;
	revision: number;
	identity: boolean | null;
	transcriptFresh: boolean;
	now: number;
};

/** Observation only. Missing durable item retry accounting forbids automatic
 * ownership mutation; callers must reserve an authoritative retry token. */
export function observeDeadClaim(
	previous: DeadEpisode | undefined,
	observation: RecoveryObservation,
	graceMs = 10 * 60_000,
): {
	episode: DeadEpisode;
	action: "hold" | "live" | "grace" | "quarantine";
	notify: boolean;
} {
	const { lane, owner, revision, identity, now } = observation;
	const same = previous?.owner === owner && previous.revision === revision;
	const episode: DeadEpisode = {
		owner,
		revision,
	};
	const local = lane.host === observation.localHost;
	const valid =
		local &&
		lane.sid === owner &&
		Number.isSafeInteger(lane.pid) &&
		(lane.pid ?? 0) > 0 &&
		Number.isSafeInteger(revision) &&
		revision >= 0;
	if (!valid || identity === null)
		return { episode, action: "hold", notify: false };
	if (identity === true) return { episode, action: "live", notify: false };
	if (observation.transcriptFresh)
		return { episode, action: "hold", notify: false };
	if (same) {
		episode.quarantined = previous?.quarantined;
		episode.lastRecoveryResult = previous?.lastRecoveryResult;
	}
	const first = same ? previous?.firstConfirmedDeadAt : undefined;
	const since =
		typeof first === "number" && Number.isFinite(first) && first <= now
			? first
			: now;
	episode.firstConfirmedDeadAt = since;
	if (now - since < graceMs)
		return { episode, action: "grace", notify: first === undefined };
	episode.quarantined = true;
	return {
		episode,
		action: "quarantine",
		notify: !same || !previous?.quarantined,
	};
}

export function recordRecoveryResult(
	episode: DeadEpisode,
	result: "held" | "exhausted",
): boolean {
	const notify = episode.lastRecoveryResult !== result;
	episode.lastRecoveryResult = result;
	return notify;
}

function ensureBudget(store: GovernorStore): void {
	store.run(
		"CREATE TABLE IF NOT EXISTS work_recovery_attempts (project TEXT NOT NULL,id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project,id))",
	);
}

/** Atomic reservation stable across executor, owner, reclaim and restart.
 * Failed process rechecks and failed mutations intentionally consume tokens. */
export function reserveRecovery(
	store: GovernorStore,
	project: string,
	id: string,
	owner: string,
	revision: number,
): boolean {
	ensureBudget(store);
	return store.transaction(() => {
		const result = store
			.query(
				"INSERT INTO work_recovery_attempts(project,id,attempts) VALUES (?,?,1) ON CONFLICT(project,id) DO UPDATE SET attempts=attempts+1 WHERE attempts<3",
			)
			.run(project, id);
		if (!result.changes) return false;
		store
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,'fleet-loop','work.recovery-reserved',?,?,NULL)",
			)
			.run(
				Date.now(),
				id,
				JSON.stringify({ project, work: id, owner, revision }),
			);
		return true;
	})();
}

export function resetRecovery(
	store: GovernorStore,
	project: string,
	id: string,
): void {
	ensureBudget(store);
	store.transaction(() => {
		store
			.query("DELETE FROM work_recovery_attempts WHERE project=? AND id=?")
			.run(project, id);
		store
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,'work','work.recovery-reset',?,?,NULL)",
			)
			.run(Date.now(), id, JSON.stringify({ project, work: id }));
	})();
}

export function attemptRecovery(
	store: GovernorStore,
	claim: { project: string; id: string; owner: string; revision: number },
	deathConfirmed: () => boolean,
	reclaim: () => { code: number; out: string },
	reread: () => {
		project?: string;
		id?: string;
		state?: string;
		owner_sid?: string | null;
	},
): "released" | "held" | "exhausted" {
	if (
		!reserveRecovery(
			store,
			claim.project,
			claim.id,
			claim.owner,
			claim.revision,
		)
	)
		return "exhausted";
	if (!deathConfirmed()) return "held";
	const result = reclaim();
	if (result.code !== 0) return "held";
	try {
		const receipt = JSON.parse(result.out);
		if (
			receipt.released !== true ||
			receipt.project !== claim.project ||
			receipt.id !== claim.id ||
			receipt.previousOwner !== claim.owner ||
			receipt.previousUpdatedAt !== claim.revision
		)
			return "held";
		const after = reread();
		return after.project === claim.project &&
			after.id === claim.id &&
			after.state === "READY" &&
			after.owner_sid === null
			? "released"
			: "held";
	} catch {
		return "held";
	}
}

if (import.meta.main) {
	// Explicit operator reset; no supervisor invokes this path.
	const args = process.argv.slice(2);
	const project = args[args.indexOf("--project") + 1];
	const id = args[args.indexOf("--item") + 1];
	if (
		args[0] !== "reset" ||
		!args.includes("--project") ||
		!project ||
		!args.includes("--item") ||
		!/^W\d+(?:\.\d+)*$/.test(id ?? "")
	)
		throw new Error(
			"usage: dead-claim-recovery.ts reset --project <git-common-dir> --item <Wn>",
		);
	const { openStore } = await import("./govdb.ts");
	resetRecovery(openStore(), project, id);
	console.log(JSON.stringify({ project, id, reset: true }));
}
