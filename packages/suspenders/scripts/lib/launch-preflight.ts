import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { releaseWorkClaim } from "../../hooks/lib/work-release.ts";
import type { GovernorStore } from "../../hooks/lib/govdb.ts";

/** Daemon PATHs differ from interactive shells. Explicit operator paths are
 * authoritative; canonical user install plus PATH are a bounded fallback. */
export function resolveLaneExecutor(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (!["claude", "copilot", "codex"].includes(name)) return null;
	const configured = env[`SUSPENDERS_${name.toUpperCase()}_BIN`];
	const candidates = configured
		? [configured]
		: [
				env.HOME ? join(env.HOME, ".local/bin", name) : "",
				...(env.PATH ?? "")
					.split(":")
					.filter(isAbsolute)
					.slice(0, 64)
					.map((dir) => join(dir, name)),
			];
	for (const path of candidates) {
		if (!isAbsolute(path)) continue;
		try {
			accessSync(path, constants.X_OK);
			if (statSync(path).isFile()) return path;
		} catch {
			/* try next bounded candidate */
		}
	}
	return null;
}

/** The configured store owns the claim. Both owner and revision gate cleanup,
 * so a transfer or renewal cannot be overwritten by a failed older launch. */
export function releaseFailedLaunch(
	store: GovernorStore,
	claim: {
		project: string;
		item: string;
		sid: string;
		revision: number;
		nonce?: string;
	},
): boolean {
	const item = store
		.query(
			"SELECT state FROM work_items WHERE project=? AND id=? AND owner_sid=? AND updated_at=? AND state IN ('CLAIMED','RUNNING')",
		)
		.get(claim.project, claim.item, claim.sid, claim.revision) as {
		state: string;
	} | null;
	return item
		? releaseWorkClaim(
				store,
				{
					project: claim.project,
					id: claim.item,
					owner: claim.sid,
					state: item.state,
					updatedAt: claim.revision,
				},
				{ by: claim.sid, reason: "owner-release" },
				() =>
					!claim.nonce ||
					ownsLaunchLease(store, claim.project, claim.sid, claim.nonce),
			)
		: false;
}

const LEASE_MS = 10 * 60_000;
export function acquireLaunchLease(
	store: GovernorStore,
	project: string,
	sid: string,
	nonce: string,
	now = Date.now(),
): boolean {
	return store.transaction(() => {
		store.run(
			"CREATE TABLE IF NOT EXISTS lane_launch_leases(project TEXT NOT NULL,sid TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(project,sid))",
		);
		return !!store
			.query(
				"INSERT INTO lane_launch_leases VALUES (?,?,?,?) ON CONFLICT(project,sid) DO UPDATE SET nonce=excluded.nonce,expires_at=excluded.expires_at WHERE lane_launch_leases.expires_at<=?",
			)
			.run(project, sid, nonce, now + LEASE_MS, now).changes;
	})();
}
export function ownsLaunchLease(
	store: GovernorStore,
	project: string,
	sid: string,
	nonce: string,
): boolean {
	return !!store
		.query(
			"SELECT 1 FROM lane_launch_leases WHERE project=? AND sid=? AND nonce=?",
		)
		.get(project, sid, nonce);
}
export function renewLaunchLease(
	store: GovernorStore,
	project: string,
	sid: string,
	nonce: string,
): boolean {
	return !!store
		.query(
			"UPDATE lane_launch_leases SET expires_at=? WHERE project=? AND sid=? AND nonce=?",
		)
		.run(Date.now() + LEASE_MS, project, sid, nonce).changes;
}
export function releaseLaunchLease(
	store: GovernorStore,
	project: string,
	sid: string,
	nonce: string,
): void {
	store
		.query(
			"DELETE FROM lane_launch_leases WHERE project=? AND sid=? AND nonce=?",
		)
		.run(project, sid, nonce);
}
