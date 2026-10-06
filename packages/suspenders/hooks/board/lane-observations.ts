import type { GovernorStore } from "../lib/govdb.ts";

export interface LaneObservation {
	laneId: string;
	project: string;
	originHub: string;
	peerHub: string;
	observedAt: number;
	expiresAt: number;
	visitedHubs?: string[];
}

/** Operator-authenticated observations are evidence, never ownership or liveness. */
export function ensureLaneObservations(db: GovernorStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS board_lane_observations (
		lane_id TEXT NOT NULL, project TEXT NOT NULL, origin_hub TEXT NOT NULL,
		peer_hub TEXT NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
		PRIMARY KEY (lane_id, project, origin_hub, peer_hub))`);
	const columns = db
		.query("PRAGMA table_info(board_lane_observations)")
		.all() as { name: string }[];
	if (!columns.some((column) => column.name === "visited_hubs"))
		db.run(
			"ALTER TABLE board_lane_observations ADD COLUMN visited_hubs TEXT NOT NULL DEFAULT '[]'",
		);
}

export function recordLaneObservation(
	db: GovernorStore,
	input: unknown,
	now = Date.now(),
): { ok: boolean; error?: string } {
	if (!input || typeof input !== "object" || Array.isArray(input))
		return { ok: false, error: "Expected an observation object" };
	const o = input as Record<string, unknown>;
	for (const [key, max] of [
		["laneId", 128],
		["project", 1024],
		["originHub", 128],
		["peerHub", 128],
	] as const) {
		const value = o[key];
		if (
			typeof value !== "string" ||
			!value.trim() ||
			value.length > max ||
			[...value].some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
			)
		)
			return { ok: false, error: `Invalid ${key}` };
		if (
			(key === "originHub" || key === "peerHub") &&
			["all", "unknown"].includes(value)
		)
			return { ok: false, error: `${key} cannot use reserved filter names` };
	}
	const observedAt = o.observedAt;
	const expiresAt = o.expiresAt;
	const visitedHubs = o.visitedHubs ?? [];
	if (
		!Array.isArray(visitedHubs) ||
		visitedHubs.length > 16 ||
		visitedHubs.some(
			(hub) =>
				typeof hub !== "string" ||
				!hub.trim() ||
				hub.length > 128 ||
				["all", "unknown"].includes(hub) ||
				[...hub].some(
					(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
				),
		) ||
		new Set(visitedHubs).size !== visitedHubs.length
	)
		return { ok: false, error: "Invalid visitedHubs ancestry" };
	if (
		typeof observedAt !== "number" ||
		typeof expiresAt !== "number" ||
		!Number.isSafeInteger(observedAt) ||
		!Number.isSafeInteger(expiresAt) ||
		observedAt > now + 5_000 ||
		observedAt < now - 86_400_000 ||
		expiresAt <= now ||
		expiresAt <= observedAt ||
		expiresAt > observedAt + 86_400_000
	)
		return {
			ok: false,
			error: "Observation times must be current with a TTL of at most 24 hours",
		};
	db.transaction(() => {
		db.run("DELETE FROM board_lane_observations WHERE expires_at <= ?", now);
		db.run(
			`INSERT INTO board_lane_observations (lane_id, project, origin_hub, peer_hub, observed_at, expires_at, visited_hubs)
			VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lane_id, project, origin_hub, peer_hub)
			DO UPDATE SET observed_at = excluded.observed_at, expires_at = excluded.expires_at, visited_hubs = excluded.visited_hubs
			WHERE excluded.observed_at >= board_lane_observations.observed_at`,
			o.laneId,
			o.project,
			o.originHub,
			o.peerHub,
			observedAt,
			expiresAt,
			JSON.stringify(visitedHubs),
		);
		db.run(
			"DELETE FROM board_lane_observations WHERE rowid NOT IN (SELECT rowid FROM board_lane_observations ORDER BY observed_at DESC, rowid DESC LIMIT 1000)",
		);
	})();
	return { ok: true };
}

export function laneObservationSnapshot(
	db: GovernorStore,
	project: string | null = null,
	now = Date.now(),
) {
	const scoped = !!project && project !== "all";
	const rows = db
		.query(`SELECT lane_id AS laneId, project, origin_hub AS originHub,
		peer_hub AS peerHub, observed_at AS observedAt, expires_at AS expiresAt, visited_hubs AS ancestry
		FROM board_lane_observations WHERE expires_at > ? AND observed_at <= ? ${scoped ? "AND project = ?" : ""}
		ORDER BY observed_at DESC LIMIT 1000`)
		.all(
			...(scoped ? [now, now + 5_000, project] : [now, now + 5_000]),
		) as (LaneObservation & { ancestry: string })[];
	const lanes = rows.map(({ ancestry, ...lane }) => ({
		...lane,
		visitedHubs: JSON.parse(ancestry) as string[],
	}));
	return {
		ts: now,
		source: "authenticated-operator-observation" as const,
		lanes,
		origins: [...new Set(lanes.map((o) => o.originHub))].sort(),
		peers: [...new Set(lanes.map((o) => o.peerHub))].sort(),
	};
}
