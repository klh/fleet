// scripts/lib/controller-fence.ts — W576.5 single-authority fencing for the
// fleet-loop controller. The controller (fleet-loop watch) holds a governor.db
// lease keyed by canonical project identity; a second watch STANDBYS (sleeps,
// never acts) while the holder is live, takes over only a provably dead
// holder (pid + microsecond birth identity, same machine), and refuses when
// liveness is unknown (cross-host or unreadable). The lease records the
// controller's generation — the harness receipt revision of its code root —
// so a handoff can verify the successor actually runs the intended immutable
// payload.
//
// Handoff is request-driven and idle-safe: the owner-invoked tool writes a
// request row; the old controller releases authority at its next cycle
// boundary (between cycle children — inherently idle), launchd KeepAlive
// respawns the unit, and the successor marks the handoff assumed. Lanes are
// separate processes — never touched. Governor outage: the fence fails CLOSED
// (no acting without a verifiable lease); explicit per-operation outage
// behavior remains W576.3's to unify.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { GovernorStore } from "../../hooks/lib/govdb.ts";
import { type ProcessBirth, processBirth } from "./launch-fencing.ts";

export interface ControllerLease {
	project: string;
	nonce: string;
	host: string;
	pid: number;
	birth: string;
	generation: string;
	code_root: string;
	started_at: number;
	renewed_at: number;
}

export interface ControllerHandoff {
	project: string;
	from_nonce: string | null;
	target_generation: string;
	target_root: string;
	requested_at: number;
	state: "requested" | "released" | "assumed" | "cancelled";
	assumed_generation: string | null;
	assumed_pid: number | null;
	assumed_at: number | null;
}

const LEASES = "controller_leases";
const HANDOFFS = "controller_handoffs";

/** The harness receipt revision of the running code root; a checkout run
 * (no receipt) falls back to its exact entrypoint path as identity. */
export function controllerGeneration(scriptPath: string): string {
	let dir = realpathSync(dirname(scriptPath));
	for (let depth = 0; depth < 8; depth++) {
		const receipt = join(dir, "harness-receipt.json");
		if (existsSync(receipt)) {
			try {
				const parsed = JSON.parse(readFileSync(receipt, "utf8")) as {
					revision?: unknown;
				};
				if (
					typeof parsed.revision === "string" &&
					/^[a-f0-9]{40}$/.test(parsed.revision)
				)
					return parsed.revision;
			} catch {
				/* unreadable receipt — fall through to the entrypoint identity */
			}
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return realpathSync(scriptPath);
}

/** This process's controller identity: pid + microsecond birth, generation
 * and code root — derived from the CALLER's entrypoint (the controller
 * script), never this lib. Birth must be readable or the process refuses
 * to act. */
export function currentControllerIdentity(
	nonce: string,
	scriptPath: string,
): {
	nonce: string;
	pid: number;
	birth: string;
	generation: string;
	codeRoot: string;
} {
	const birth = processBirth(process.pid);
	if (!birth || birth === false)
		throw new Error(
			"controller process birth unavailable; refusing unfenced authority",
		);
	return {
		nonce,
		pid: process.pid,
		birth: birth.birth,
		generation: controllerGeneration(scriptPath),
		codeRoot: realpathSync(dirname(scriptPath)),
	};
}

/** macOS flips a host between .local and .localdomain; only that suffix pair
 * normalizes (launch-fencing). pid+birth fencing stays the gate. */
function sameMachine(a: string, b: string): boolean {
	return (
		a.replace(/(?:\.(?:local|localdomain))+$/i, "") ===
		b.replace(/(?:\.(?:local|localdomain))+$/i, "")
	);
}

/** Liveness of a recorded controller holder, pid+birth against the live
 * process table: false proves dead; cross-host or unreadable is unknown. */
export function controllerHolderLiveness(
	holder: Pick<ControllerLease, "host" | "pid" | "birth">,
	inspect: (pid: number) => ProcessBirth | false | null = processBirth,
): "alive" | "dead" | "unknown" {
	if (!sameMachine(holder.host, hostname())) return "unknown";
	if (!Number.isSafeInteger(holder.pid) || holder.pid < 1 || !holder.birth)
		return "unknown";
	const current = inspect(holder.pid);
	if (current === false) return "dead";
	if (!current) return "unknown";
	if (current.birth !== holder.birth) return "dead";
	return "alive";
}

export function controllerFenceSchema(store: GovernorStore): void {
	store.run(
		`CREATE TABLE IF NOT EXISTS ${LEASES}(project TEXT PRIMARY KEY,nonce TEXT NOT NULL,host TEXT NOT NULL,pid INTEGER NOT NULL,birth TEXT NOT NULL,generation TEXT NOT NULL,code_root TEXT NOT NULL,started_at INTEGER NOT NULL,renewed_at INTEGER NOT NULL)`,
	);
	store.run(
		`CREATE TABLE IF NOT EXISTS ${HANDOFFS}(project TEXT PRIMARY KEY,from_nonce TEXT,target_generation TEXT NOT NULL,target_root TEXT NOT NULL,requested_at INTEGER NOT NULL,state TEXT NOT NULL,assumed_generation TEXT,assumed_pid INTEGER,assumed_at INTEGER)`,
	);
}

export function observeControllerLease(
	store: GovernorStore,
	project: string,
): ControllerLease | null {
	controllerFenceSchema(store);
	return store
		.query(`SELECT * FROM ${LEASES} WHERE project=?`)
		.get(project) as ControllerLease | null;
}

export function peekControllerHandoff(
	store: GovernorStore,
	project: string,
): ControllerHandoff | null {
	controllerFenceSchema(store);
	return store
		.query(`SELECT * FROM ${HANDOFFS} WHERE project=?`)
		.get(project) as ControllerHandoff | null;
}

/** Acquire or refresh the single-authority lease. Refused (false) while a
 * live or unknown holder keeps it; a provably dead holder is taken over —
 * both inside one store transaction, so two standby controllers racing a
 * dead holder elect exactly one. Same-nonce acquire refreshes renewed_at. */
export function acquireControllerLease(
	store: GovernorStore,
	project: string,
	identity: {
		nonce: string;
		pid: number;
		birth: string;
		generation: string;
		codeRoot: string;
	},
): boolean {
	controllerFenceSchema(store);
	return store.transaction(() => {
		const row = observeControllerLease(store, project);
		if (row && row.nonce !== identity.nonce) {
			if (controllerHolderLiveness(row) !== "dead") return false;
			store
				.query(`DELETE FROM ${LEASES} WHERE project=? AND nonce=?`)
				.run(project, row.nonce);
		}
		const now = Date.now();
		if (row && row.nonce === identity.nonce) {
			store
				.query(`UPDATE ${LEASES} SET renewed_at=? WHERE project=? AND nonce=?`)
				.run(now, project, identity.nonce);
			return true;
		}
		store
			.query(
				`INSERT INTO ${LEASES}(project,nonce,host,pid,birth,generation,code_root,started_at,renewed_at) VALUES (?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				project,
				identity.nonce,
				hostname(),
				identity.pid,
				identity.birth,
				identity.generation,
				identity.codeRoot,
				now,
				now,
			);
		return true;
	})();
}

/** Release only the caller's own lease; false when authority already left. */
export function releaseControllerLease(
	store: GovernorStore,
	project: string,
	nonce: string,
): boolean {
	controllerFenceSchema(store);
	const gone = store
		.query(`DELETE FROM ${LEASES} WHERE project=? AND nonce=?`)
		.run(project, nonce);
	return gone.changes === 1;
}

/** Owner-invoked handoff request. With a live lease the request must name
 * the holder's nonce exactly; with no lease it may target a fresh
 * assumption (from_nonce null). Overwrites a cancelled/stale prior request. */
export function requestControllerHandoff(
	store: GovernorStore,
	project: string,
	input: { fromNonce?: string; targetGeneration: string; targetRoot: string },
): void {
	controllerFenceSchema(store);
	store.transaction(() => {
		const row = observeControllerLease(store, project);
		const fromNonce = input.fromNonce ?? null;
		if (row && fromNonce !== row.nonce)
			throw new Error(
				"handoff request names a controller other than the live lease holder",
			);
		if (!row && fromNonce !== null)
			throw new Error(
				"handoff request names a holder, but no live lease exists",
			);
		store
			.query(
				`INSERT INTO ${HANDOFFS}(project,from_nonce,target_generation,target_root,requested_at,state) VALUES (?,?,?,?,?,'requested') ON CONFLICT(project) DO UPDATE SET from_nonce=excluded.from_nonce,target_generation=excluded.target_generation,target_root=excluded.target_root,requested_at=excluded.requested_at,state='requested',assumed_generation=NULL,assumed_pid=NULL,assumed_at=NULL`,
			)
			.run(
				project,
				fromNonce,
				input.targetGeneration,
				input.targetRoot,
				Date.now(),
			);
	})();
}

/** The old controller, at an idle cycle boundary, confirms a request that
 * was made for it (or was fence-less) and marks it released. */
export function markHandoffReleased(
	store: GovernorStore,
	project: string,
	nonce: string,
): boolean {
	controllerFenceSchema(store);
	const changed = store
		.query(
			`UPDATE ${HANDOFFS} SET state='released' WHERE project=? AND state='requested' AND (from_nonce IS NULL OR from_nonce=?)`,
		)
		.run(project, nonce);
	return changed.changes === 1;
}

/** Owner cancel of a pending handoff; false when nothing pends. */
export function cancelControllerHandoff(
	store: GovernorStore,
	project: string,
): boolean {
	controllerFenceSchema(store);
	const changed = store
		.query(
			`UPDATE ${HANDOFFS} SET state='cancelled' WHERE project=? AND state='requested'`,
		)
		.run(project);
	return changed.changes === 1;
}

/** The successor controller records its assumption with its own generation
 * so the handoff tool can verify the intended payload actually took over. */
export function markHandoffAssumed(
	store: GovernorStore,
	project: string,
	identity: { nonce: string; pid: number; generation: string },
): boolean {
	controllerFenceSchema(store);
	const changed = store
		.query(
			`UPDATE ${HANDOFFS} SET state='assumed',assumed_generation=?,assumed_pid=?,assumed_at=? WHERE project=? AND state IN ('requested','released')`,
		)
		.run(identity.generation, identity.pid, Date.now(), project);
	return changed.changes === 1;
}

/** One watch-mode boundary (W576.5): acquire-or-renew the single-authority
 * lease, honor an owner-requested handoff by releasing authority at this
 * idle point (between cycle children — inherently idle), and, on fresh
 * authority, record the assumption of a pending handoff so the owner tool
 * can verify the successor actually runs the intended generation. Standby
 * (no cycles) while a provably alive holder keeps the lease; takeover only
 * a provably dead holder; unknown never acts. */
export function controllerWatchBoundary(
	store: GovernorStore,
	project: string,
	identity: {
		nonce: string;
		pid: number;
		birth: string;
		generation: string;
		codeRoot: string;
	},
): "acting" | "standby" | "handoff" {
	controllerFenceSchema(store);
	if (!acquireControllerLease(store, project, identity)) return "standby";
	const request = peekControllerHandoff(store, project);
	if (request?.state === "requested" && request.from_nonce === identity.nonce) {
		markHandoffReleased(store, project, identity.nonce);
		releaseControllerLease(store, project, identity.nonce);
		return "handoff";
	}
	if (request?.state === "requested" || request?.state === "released")
		markHandoffAssumed(store, project, identity);
	return "acting";
}
