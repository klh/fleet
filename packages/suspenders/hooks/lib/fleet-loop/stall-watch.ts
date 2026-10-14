// fleet-loop/stall-watch.ts — the stall watchdog (autow428): one
// lane.stalled broadcast per stall episode, lane.resumed on recovery, and
// dead-claim observation/quarantine/recovery (W740 split; bodies verbatim).

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { openStore, projectIdentity } from "../govdb.ts";
import {
	attemptRecovery,
	observeDeadClaim,
	recordRecoveryResult,
	type DeadEpisode,
} from "../dead-claim-recovery.ts";
import { laneProcessIdentity, transcriptAlive } from "../lane-liveness.ts";
import {
	canonicalWorkClaim,
	canonicalWorkReclaim,
} from "../../../scripts/lib/work-inspection.ts";
import { type Lane, type LoopDeps, readJsonSync } from "./runtime.ts";

export function createStallWatch(
	deps: LoopDeps & { STALL_WARN_MS: number },
): { stallWatch: () => void } {
	const { REPO, STALL_WARN_MS, log, lanes } = deps;
// ─── stall watchdog (the autow428 lesson, 2026-10-05) ────────────────────
// A lane can hang or die silently with its claim held — pid-alive, zero
// activity. The graph reclaims dead claims at hb expiry; the watchdog's
// job is the EARLIER verdict: a tracked, pid-alive lane with no log or
// worktree activity for STALL_WARN_MS gets ONE lane.stalled broadcast per
// episode (state in .fleet/stall.json — survives loop restarts), cleared
// with lane.resumed when activity returns. Dead claims remain held pending
// explicit recovery; automatic bulk reclaim cannot establish safe ownership.
const STALL_FILE = `${REPO}/.fleet/stall.json`;
const DEAD_FILE = `${REPO}/.fleet/dead-recovery.json`;

type StallState = Record<string, { since: number; warned: boolean }>;

// newest file mtime walk, .git excluded, 6 levels deep — the activity
// signal a frozen lane cannot fake: a working lane writes files.
function newestFileMtime(dir: string, depth = 0): number | null {
	let newest: number | null = null;
	let ents: Dirent[];
	try {
		ents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of ents) {
		if (
			[
				".git",
				".fleet",
				".claude",
				"node_modules",
				".klh-brief.md",
				".workgraph.jsonl",
			].includes(e.name)
		)
			continue;
		const p = `${dir}/${e.name}`;
		if (e.isDirectory()) {
			if (e.name === ".git" || depth >= 6) continue;
			const m = newestFileMtime(p, depth + 1);
			if (m !== null && (newest === null || m > newest)) newest = m;
		} else {
			try {
				const m = statSync(p).mtimeMs;
				if (newest === null || m > newest) newest = m;
			} catch {}
		}
	}
	return newest;
}

// one lane.stalled event per episode, one lane.resumed on recovery — the
// graph's events table is the broadcast plane (same idiom as work.landed).
function emitLaneEvent(kind: string, item: string, payload: object): void {
	try {
		openStore()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', ?, ?, ?, NULL)",
			)
			.run(Date.now(), kind, item, JSON.stringify(payload));
	} catch {}
}

function stallWatch(): void {
	const now = Date.now();
	const state: StallState = readJsonSync(STALL_FILE) ?? {};
	const dead: Record<string, DeadEpisode> = readJsonSync(DEAD_FILE) ?? {};
	const project = projectIdentity(REPO);
	const seen = new Set<string>();
	for (const l of lanes()) {
		const claim = canonicalWorkClaim(
			REPO,
			l.item,
			project,
			`${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin/work.ts`,
		);
		if (!claim) {
			delete dead[JSON.stringify([project, l.item])];
			continue;
		}

		if (
			claim.project !== project ||
			claim.id !== l.item ||
			typeof claim.updated_at !== "number" ||
			claim.owner_sid !== l.sid ||
			!["CLAIMED", "RUNNING"].includes(claim.state ?? "")
		) {
			delete dead[JSON.stringify([project, l.item])];
			continue;
		}
		seen.add(l.sid);
		const key = JSON.stringify([project, l.item]);
		const observation = observeDeadClaim(dead[key], {
			lane: l,
			localHost: hostname(),
			owner: l.sid,
			revision: claim.updated_at,
			identity: laneProcessIdentity(l),
			transcriptFresh: transcriptAlive(l.sid),
			now,
		});
		dead[key] = observation.episode;
		if (observation.action !== "live") {
			if (observation.action === "quarantine") {
				let recovery: "released" | "held" | "exhausted" = "held";
				try {
					recovery = attemptRecovery(
						openStore(),
						{ project, id: l.item, owner: l.sid, revision: claim.updated_at },
						() =>
							l.host === hostname() &&
							laneProcessIdentity(l) === false &&
							!transcriptAlive(l.sid),
						() =>
							canonicalWorkReclaim(
								REPO,
								{
									project,
									id: l.item,
									owner: l.sid,
									revision: claim.updated_at,
								},
								`${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin/work.ts`,
							),
						() =>
							canonicalWorkClaim(
								REPO,
								l.item,
								project,
								`${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin/work.ts`,
							) ?? {},
					);
				} catch {
					/* authoritative failure holds ownership; no local fallback */
				}
				if (recovery === "released") {
					delete dead[key];
					emitLaneEvent("lane.reclaimed", l.item, {
						project,
						sid: l.sid,
						previousUpdatedAt: claim.updated_at,
					});
					log(
						`RECLAIM ${l.sid} on ${l.item} — exact scoped receipt and READY state verified`,
					);
				} else if (recordRecoveryResult(observation.episode, recovery)) {
					log(
						`RECOVERY-HELD ${l.sid} on ${l.item} — ${recovery}; operator decision required`,
					);
					emitLaneEvent("NEED_DECISION", l.item, {
						project,
						sid: l.sid,
						reason: `automatic recovery ${recovery}; inspect identity/claim/budget before explicit reset`,
					});
				}
			} else if (observation.notify) {
				log(
					`DEAD ${l.sid} on ${l.item} — exact local identity absent; observation grace started`,
				);
				emitLaneEvent("lane.dead", l.item, { project, sid: l.sid });
			}
			continue;
		}
		const activity =
			(l.worktree ? newestFileMtime(l.worktree) : null) ??
			l.launchedAt ??
			state[l.sid]?.since ??
			now;
		watchLane(state, seen, l, now, activity);
	}
	for (const sid of Object.keys(state)) if (!seen.has(sid)) delete state[sid];
	writeFileSync(STALL_FILE, JSON.stringify(state));
	writeFileSync(DEAD_FILE, JSON.stringify(dead), { mode: 0o600 });
}

// per-lane episode bookkeeping, split from stallWatch for the mutation gate
function watchLane(
	state: StallState,
	_seen: Set<string>,
	l: Lane,
	now: number,
	activity: number,
): void {
	if (now - activity < STALL_WARN_MS) {
		if (state[l.sid]?.warned)
			emitLaneEvent("lane.resumed", l.item, { sid: l.sid });
		delete state[l.sid];
		return;
	}
	if (!state[l.sid]) state[l.sid] = { since: activity, warned: false };
	if (state[l.sid].warned) return;
	state[l.sid].warned = true;
	log(
		`STALLED ${l.sid} on ${l.item} — product artifacts unchanged ${Math.round((now - activity) / 60000)}m`,
	);
	emitLaneEvent("lane.stalled", l.item, {
		sid: l.sid,
		stallMs: now - activity,
	});
}
	return { stallWatch };
}
