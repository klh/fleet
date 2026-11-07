// ghost-sweep.ts — W2842: the ONE pass that transitions heartbeat-dead
// RUNNING sessions to the terminal GHOSTED state. Board reality first: rows
// stay state=RUNNING forever when a lane dies without a terminal write
// (crash, SIGKILL, machine death), /api/data verdict=dead marks them, and
// NOTHING transitions them — so the lanes view paints dozens of ghosts as
// stale/failed and every watchdog NEED_DECISION storm re-reads them.
// Evidence chain (monitor doctrine W51: unknown never ghosts):
//   stale hb (45 min for registry-carrying lanes, 24 h for unregistered
//   ones — the W610 manual-Codex conservatism) + positive process-death
//   evidence (registry pid identity === false, or no registry row with a
//   dead transcript) + no live claim (probeClaim verdict; a hot claims
//   row keeps) + no OPEN decision waiting on the sid + never the
//   coordinator. Bounded batch per pass; CAS on state='RUNNING' so a lane
//   that woke mid-pass keeps its row.
import type { GovernorStore } from "../govdb/govdb.ts";
import {
	type LaneRef,
	type ProcessInspector,
	laneProcessIdentity,
	transcriptAlive,
} from "./lane-liveness.ts";
import { matchingClaimantLane } from "./reclaim-all.ts";
import { probeClaim } from "./reclaim-liveness.ts";

// parity with the board's fleet.zombie_after_ms default (board/lanes.ts)
export const GHOST_HB_STALE_MS = 45 * 60_000;
// unregistered lanes keep the sweepStaleSessions parented-lane conservatism
export const GHOST_UNREGISTERED_MS = 24 * 3_600_000;
const GHOST_BATCH = 25;

export interface GhostSweepOptions {
	/** the repo whose .fleet/lanes.json the process identity joins on */
	registryDir: string;
	now?: number;
	batch?: number;
	inspect?: ProcessInspector;
	/** test seam over transcriptsAliveBatch */
	transcripts?: Map<string, boolean>;
	/** test seam over loadLaneRegistry */
	registry?: Map<string, LaneRef>;
	/** false = dry-run report only (the default face) */
	act?: boolean;
}

export interface GhostDecision {
	sid: string;
	action: "ghosted" | "kept";
	why: string;
}

export function ghostSweep(
	store: GovernorStore,
	opts: GhostSweepOptions,
): GhostDecision[] {
	const now = opts.now ?? Date.now();
	const batch = opts.batch ?? GHOST_BATCH;
	const registry = opts.registry ?? new Map<string, LaneRef>();
	const coordinatorSid =
		(
			store
				.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
				.get() as { value: string } | null
		)?.value ?? null;
	const waiting = new Set<string>();
	try {
		for (const r of store
			.query(
				"SELECT answer_to AS sid FROM decisions WHERE state = 'OPEN' AND answer_to IS NOT NULL",
			)
			.all() as { sid: string }[])
			waiting.add(r.sid);
	} catch {
		// no decisions table yet — nothing is waiting
	}
	const candidates = store
		.query(
			"SELECT sid, role, hb FROM sessions WHERE state = 'RUNNING' AND hb < ? ORDER BY hb",
		)
		.all(now - GHOST_HB_STALE_MS) as {
		sid: string;
		role: string | null;
		hb: number;
	}[];
	const fresh = (sid: string): boolean =>
		opts.transcripts
			? (opts.transcripts.get(sid) ?? false)
			: transcriptAlive(sid);
	const out: GhostDecision[] = [];
	for (const c of candidates) {
		if (out.length >= batch) break;
		const kept = (why: string): GhostDecision => ({
			sid: c.sid,
			action: "kept",
			why,
		});
		if (c.role === "coordinator" || c.sid === coordinatorSid) {
			out.push(kept("coordinator"));
			continue;
		}
		if (waiting.has(c.sid)) {
			out.push(kept("open decision waiting on the lane"));
			continue;
		}
		const lane = registry.get(c.sid);
		// unregistered lanes: the conservative 24 h window + dead transcript
		// (the SQL already cut at 45 min — only unregistered rows can still be
		// inside their 24 h floor)
		if (!lane && now - c.hb < GHOST_UNREGISTERED_MS) {
			out.push(kept("unregistered — heartbeat within the 24h floor"));
			continue;
		}
		// live-claim guard: any non-dead claim, or a hot claims row, keeps
		let liveClaim: string | null = null;
		const hot = store
			.query("SELECT 1 AS x FROM claims WHERE sid = ? AND hot = 1 LIMIT 1")
			.get(c.sid);
		if (hot) liveClaim = "hot claims row";
		if (!liveClaim) {
			for (const r of store
				.query(
					"SELECT project, id, owner_sid, updated_at FROM work_items WHERE owner_sid = ? AND state IN ('CLAIMED','RUNNING')",
				)
				.all(c.sid) as {
				project: string;
				id: string;
				owner_sid: string | null;
				updated_at: number;
			}[]) {
				const owner = String(r.owner_sid ?? "");
				const probe = probeClaim(store, r.project, {
					id: String(r.id),
					owner,
					revision: Number(r.updated_at),
					...(lane
						? { lane: matchingClaimantLane(registry, owner, String(r.id)) }
						: {}),
					...(opts.inspect ? { inspect: opts.inspect } : {}),
				});
				if (probe.verdict !== "dead") {
					liveClaim = `claim ${String(r.id)} ${probe.verdict}`;
					break;
				}
			}
		}
		if (liveClaim) {
			out.push(kept(liveClaim));
			continue;
		}
		// process-death evidence: a registry lane must read positively dead;
		// an unregistered lane needs the transcript dead (already checked via
		// the fresh() term below)
		if (lane) {
			const identity = opts.inspect
				? laneProcessIdentity(lane, opts.inspect)
				: laneProcessIdentity(lane);
			if (identity !== false) {
				out.push(kept(`process identity ${String(identity)}`));
				continue;
			}
		}
		if (fresh(c.sid)) {
			out.push(kept("transcript fresh"));
			continue;
		}
		if (opts.act === true) {
			const changed = store
				.query(
					"UPDATE sessions SET state = 'GHOSTED' WHERE sid = ? AND state = 'RUNNING'",
				)
				.run(c.sid);
			if (Number(changed.changes) === 0) {
				out.push(kept("state changed mid-pass"));
				continue;
			}
			store.run(
				"INSERT INTO events (ts, source, kind, scope, payload) VALUES (?, ?, 'session.ghosted', 'suspenders', ?)",
				now,
				"ghost-sweep",
				JSON.stringify({ sid: c.sid, hb_age_ms: now - Number(c.hb) }),
			);
		}
		out.push({
			sid: c.sid,
			action: "ghosted",
			why: "heartbeat dead + no live process + no live claim",
		});
	}
	return out;
}
