// fleet-loop/lost-hub.ts — W2321.4: the lost-hub requeue policy (MultiKueue
// loss discipline, docs/design/multikueue-hub-dispatch.md §2b). A hub-side
// lane lives on a foreign host, so the ordinary liveness faces can NEVER
// condemn it (laneVerdict: foreign host → alive/unknown only) — a lost hub
// would strand its claims forever. This policy replaces that with the
// MultiKueue shape:
//   first-loss grace — the loss clock anchors at the FIRST observed loss and
//     never resets on failed re-probes (connectionState.disconnectedSince,
//     multikueuecluster.go:206-250). Default 15 min (workerLostTimeout,
//     apis/config/v1beta2/defaults.go:51). Knob
//     SUSPENDERS_HUB_LOST_GRACE_MS (floor 60s).
//   budgeted requeue — past grace, the hub's CLAIMED items requeue → READY
//     through the ONE release path (work-release.ts), each release reserving
//     from the SAME per-item recovery budget the dead-claim FSM uses
//     (work_recovery_attempts, ≤3 lifetime). An exhausted item holds its
//     state and raises NEED_DECISION — requeue is BUDGETED and loud, never a
//     silent total-loss assumption (§6: a lane's in-flight context is not
//     re-admittable, but the WORK is not lost — it requeues).
//   hold terms — a claimant still talking (fresh sessions.hb through the
//     store face, W2321.3 evidence flow) is alive regardless of ssh
//     reachability; `work extend` leases and `.fleet/reclaim-paused` /
//     `.fleet/lost-hub-paused` markers hold; a probe that could not run
//     (spawn failure, not ssh refusal) is NO observation (W51: lookup
//     failure is never death) — the pass skips, the anchored clock keeps
//     running but no release fires without a fresh positive loss verdict.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GovernorStore } from "../govdb/govdb.ts";
import { reserveRecovery } from "../lanes/dead-claim-recovery.ts";
import { loadLaneRegistry } from "../lanes/lane-registry.ts";
import { probeClaim } from "../lanes/reclaim-liveness.ts";
import { releaseWorkClaim } from "../work/work-release.ts";
import { automaticRecoveryPaused } from "./automatic-recovery.ts";

export const HUB_LOST_GRACE_DEFAULT_MS = 15 * 60_000;
export const HUB_LOST_GRACE_FLOOR_MS = 60_000;
export const LOST_HUB_PAUSE = "lost-hub-paused";

/** SUSPENDERS_HUB_LOST_GRACE_MS — junk/absent → default; floor 60s. */
export function hubLostGraceMs(raw?: string): number {
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n <= 0) return HUB_LOST_GRACE_DEFAULT_MS;
	return Math.max(n, HUB_LOST_GRACE_FLOOR_MS);
}

/** One resolution point for the bin's --grace-ms and the env knob (B2,
 * W2510 review): the override wins when present, else the knob, else the
 * 15-min default — and EVERY path rides the sanitizer, never a bare
 * Number() (NaN classified as zero grace → first-probe requeue; "0"
 * bypassing the 60s floor). */
export function resolveLostHubGraceMs(override?: string): number {
	return hubLostGraceMs(override || process.env.SUSPENDERS_HUB_LOST_GRACE_MS);
}

export const lostHubPaused = (repo: string): boolean =>
	existsSync(join(repo, ".fleet", LOST_HUB_PAUSE));

// ---- the episode state (facts table, the reclaim.strike idiom) -------------

export type LostHubEpisode = {
	/** ms epoch of the FIRST observed loss this episode — the grace anchor. */
	firstLostAt?: number;
	lastLostAt?: number;
	/** true once this episode has requeued anything (notify transitions). */
	requeued?: boolean;
};

const episodeKey = (project: string, hub: string): string =>
	`hublost.episode.${project}.${hub}`;

export function readEpisode(
	store: GovernorStore,
	project: string,
	hub: string,
): LostHubEpisode {
	// N2 (W2510 review): a corrupt facts row THROWS instead of collapsing to
	// {} — an empty episode silently re-anchors the grace clock at now,
	// granting a lost hub a fresh grace window every pass (claims stranded
	// forever, the failure this policy exists to prevent). The caller skips
	// classification and surfaces the corruption; only a MISSING row is a
	// legitimate empty episode.
	const row = store
		.query("SELECT value FROM facts WHERE key = ?")
		.get(episodeKey(project, hub)) as { value: string } | null;
	if (!row) return {};
	const v = JSON.parse(row.value) as Partial<LostHubEpisode>;
	const out: LostHubEpisode = {};
	if (typeof v.firstLostAt === "number") out.firstLostAt = v.firstLostAt;
	if (typeof v.lastLostAt === "number") out.lastLostAt = v.lastLostAt;
	if (v.requeued === true) out.requeued = true;
	return out;
}

export function writeEpisode(
	store: GovernorStore,
	project: string,
	hub: string,
	episode: LostHubEpisode,
): void {
	store.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-loop', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		episodeKey(project, hub),
		JSON.stringify(episode),
		Date.now(),
	);
}

// ---- pure classification -----------------------------------------------------

export type HubLinkObservation = {
	hub: string;
	/** the probe RAN and answered: false = hub unreachable (positive loss). */
	reachable: boolean;
	now: number;
};

/** Map a probe leg's exit to an observation verdict. The MultiKueue
 * connectionState shape (multikueuecluster.go:206-250): a transport refusal
 * — ssh exit 255, connection refused/reset, timeout — IS the disconnect
 * observation (the hub host itself is dark), so loss accrues; only a local
 * spawn failure (ssh binary missing, code 127) is NO observation — W51,
 * lookup failure is never death. */
export function classifyProbeRun(code: number): "reachable" | "lost" | "none" {
	if (code === 0) return "reachable";
	if (code === 255 || code === 1) return "lost"; // ssh transport refused/failed
	if (code === 124 || code === 143) return "lost"; // timeout / SIGTERM'd probe
	return "none"; // local spawn failure (127 etc.) — probe never ran
}

export type LostHubAction = "ok" | "grace" | "requeue";

/** One observation → episode + action. The clock anchors at the first loss
 * and survives every later failed probe; recovery resets the episode. */
export function classifyLostHub(
	previous: LostHubEpisode,
	observation: HubLinkObservation,
	graceMs: number = hubLostGraceMs(process.env.SUSPENDERS_HUB_LOST_GRACE_MS),
): { episode: LostHubEpisode; action: LostHubAction; notify: boolean } {
	if (observation.reachable) {
		const recovered = previous.firstLostAt !== undefined;
		return { episode: {}, action: "ok", notify: recovered };
	}
	const first =
		previous.firstLostAt !== undefined &&
		previous.firstLostAt <= observation.now
			? previous.firstLostAt
			: observation.now; // FIRST loss anchors; retries never reset it
	const episode: LostHubEpisode = {
		firstLostAt: first,
		lastLostAt: observation.now,
		requeued: previous.requeued,
	};
	if (observation.now - first < graceMs)
		return {
			episode,
			action: "grace",
			notify: previous.firstLostAt === undefined,
		};
	return { episode, action: "requeue", notify: !previous.requeued };
}

// ---- hub↔lane mapping ---------------------------------------------------------

/** First DNS label, lowercased — `nas.threads.dk` and a hub-stamped
 * `hostname()` like `nas` / `NAS.local` join on one key. */
export const hubHostKey = (host: string): string =>
	host.trim().toLowerCase().replace(/\..*$/, "") || host.trim().toLowerCase();

/** The hub label a lane's host maps to, or null (not a hub lane). */
export function hubForLaneHost(
	laneHost: string | undefined,
	hubs: ReadonlyMap<string, string>, // label → deploy.ssh host part
): string | null {
	if (!laneHost) return null;
	const laneKey = hubHostKey(laneHost);
	for (const [label, sshHost] of hubs)
		if (sshHost && hubHostKey(sshHost) === laneKey) return label;
	return null;
}

/** `user@host:port` → `host`. */
export const sshHostPart = (ssh: string): string =>
	ssh.split("@").pop()?.split(":")[0] ?? "";

/** One hub profile slice the sweep walks. */
export interface LostHubTarget {
	name: string;
	ssh?: string;
	healthPort: number;
	connectTimeout?: number;
}

/** Probe: outside view of one published health face on the hub host — the
 * health-is-outside-process law (never the served process). */
export const healthProbeScript = (port: number): string =>
	`curl --max-time 3 -so /dev/null -w '%{http_code}' http://127.0.0.1:${port}/healthz || true`;

export function toLostHubTarget(
	name: string,
	hub: {
		deploy?: { ssh?: string; connect_timeout?: number };
		buckle_health_port?: number;
		quiet_hours?: string;
	},
): LostHubTarget | null {
	if (!hub.deploy) return null;
	const port = hub.buckle_health_port ?? 4112;
	if (typeof port !== "number" || port <= 0) return null;
	return {
		name,
		ssh: hub.deploy.ssh,
		healthPort: port,
		connectTimeout: hub.deploy.connect_timeout,
	};
}

/** The hub's CLAIMED/RUNNING items, joined from the lane registry — a hub
 * lane IS a registry row whose host maps to the hub profile. */
export function hubClaims(
	store: GovernorStore,
	project: string,
	registryDir: string,
	hubLabel: string,
	hubs: ReadonlyMap<string, string>,
): HubClaimRow[] {
	const lanes = loadLaneRegistry<{ sid: string; item: string; host?: string }>(
		registryDir,
	).filter((l) => l.host !== undefined);
	const rows = store
		.query(
			"SELECT id, owner_sid, state, updated_at FROM work_items WHERE project = ? AND state IN ('CLAIMED','RUNNING') ORDER BY id",
		)
		.all(project) as Record<string, string | number | null>[];
	const out: HubClaimRow[] = [];
	for (const lane of lanes) {
		if (hubForLaneHost(lane.host, hubs) !== hubLabel) continue;
		for (const r of rows)
			if (String(r.owner_sid) === lane.sid && String(r.id) === lane.item)
				out.push({
					id: String(r.id),
					owner: String(r.owner_sid ?? ""),
					state: String(r.state),
					updatedAt: Number(r.updated_at),
				});
	}
	return out;
}

// ---- the requeue application --------------------------------------------------

export type HubClaimRow = {
	id: string;
	owner: string;
	state: string;
	updatedAt: number;
};

export type RequeueOutcome =
	| { id: string; action: "released"; hub: string; why: string }
	| { id: string; action: "held"; why: string };

/** Requeue one hub's CLAIMED items. Caller has already classified the hub as
 * `requeue`. Each release reserves from the per-item recovery budget first;
 * an exhausted budget holds the claim and demands a decision. */
export function requeueHubClaims(
	store: GovernorStore,
	opts: {
		project: string;
		repo: string;
		hub: string;
		claims: HubClaimRow[];
		transport?: Map<string, boolean>;
		emitDecision: (id: string, note: string) => void;
	},
): RequeueOutcome[] {
	const { project, repo, hub, claims, transport, emitDecision } = opts;
	if (automaticRecoveryPaused(repo) || lostHubPaused(repo))
		return claims.map((c) => ({
			id: c.id,
			action: "held" as const,
			why: "recovery paused (reclaim-paused / lost-hub-paused)",
		}));
	const out: RequeueOutcome[] = [];
	for (const c of claims) {
		// hold terms first: a claimant still talking is alive; an extend
		// lease is a pause. probeClaim never condemns a foreign-host lane
		// on its own (unknown at worst) — W51.
		const probe = probeClaim(store, project, {
			id: c.id,
			owner: c.owner,
			revision: c.updatedAt,
			transport,
		});
		if (probe.verdict === "alive") {
			out.push({
				id: c.id,
				action: "held",
				why: "claimant alive (store hb/transport)",
			});
			continue;
		}
		if (probe.holdUntil !== null) {
			out.push({ id: c.id, action: "held", why: "extend lease holds" });
			continue;
		}
		if (!reserveRecovery(store, project, c.id, c.owner, c.updatedAt)) {
			emitDecision(
				c.id,
				`lost-hub ${hub}: requeue budget exhausted for ${c.id} — operator reset (dead-claim-recovery.ts reset) or manual disposition required`,
			);
			out.push({ id: c.id, action: "held", why: "requeue budget exhausted" });
			continue;
		}
		const released = releaseWorkClaim(
			store,
			{
				project,
				id: c.id,
				owner: c.owner || null,
				state: c.state,
				updatedAt: c.updatedAt,
			},
			{ by: "lost-hub-sweep", reason: "reclaim-all", cause: "lost-hub" },
		);
		out.push(
			released
				? {
						id: c.id,
						action: "released",
						hub,
						why: `hub ${hub} lost past grace — budgeted requeue → READY`,
					}
				: {
						id: c.id,
						action: "held",
						why: "claim changed mid-release — next pass re-evaluates",
					},
		);
	}
	return out;
}
