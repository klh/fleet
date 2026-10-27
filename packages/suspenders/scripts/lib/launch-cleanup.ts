// launch-cleanup.ts — W576.1.1 decomposition of dispatch-next.ts
// (1500-line law): the failed-launch unwind from dispatchItem's finally —
// own-child termination, intent + claim + key revocation, written-file
// rollback — as one context-taking function. Best-effort by design: every
// step logs and swallows; the launch lease is always released.
import { readFileSync, rmSync } from "node:fs";
import {
	finishFailedLaunch,
	terminateOwnLaunch,
	type LaunchIntent,
} from "./launch-fencing.ts";
import {
	releaseFailedLaunch,
	releaseLaunchLease,
	renewLaunchLease,
} from "./launch-preflight.ts";
import {
	adminKey,
	hubCredential,
	revokeLaneKey,
} from "../../hooks/lib/lanes/lane-auth.ts";
import type { spawnClaude } from "../../hooks/lib/lanes/lane.ts";
import type { GovernorStore } from "../../hooks/lib/govdb/govdb.ts";

type CleanupCtx = {
	committedLaunch: boolean;
	store: GovernorStore;
	project: string;
	sid: string;
	item: string;
	nonce: string;
	launchedProc: ReturnType<typeof spawnClaude> | undefined;
	intent: LaunchIntent | undefined;
	claimRevision: number | undefined;
	ownedKeyId: string | undefined;
	ownedKeyFront: string | undefined;
	hub: string | undefined;
	writtenFiles: Map<string, string>;
	log: (msg: string) => void;
};

export const launchCleanup = async (ctx: CleanupCtx): Promise<void> => {
	const {
		committedLaunch,
		store,
		project,
		sid,
		item,
		nonce,
		launchedProc,
		intent,
		claimRevision,
		ownedKeyId,
		ownedKeyFront,
		hub,
		writtenFiles,
		log,
	} = ctx;
	if (!committedLaunch) {
		let ownsFiles = false;
		let childStopped = true;
		try {
			ownsFiles = renewLaunchLease(store, project, sid, nonce);
		} catch (error) {
			log(`LAUNCH-CLEANUP ${item} — lease check failed: ${String(error)}`);
		}
		if (launchedProc && launchedProc.exitCode === null) {
			try {
				await terminateOwnLaunch(launchedProc);
			} catch (error) {
				childStopped = false;
				log(
					`LAUNCH-CLEANUP ${item} — own child termination failed: ${String(error)}`,
				);
			}
		}
		if (childStopped && intent) {
			try {
				finishFailedLaunch(store, intent);
			} catch (error) {
				log(`LAUNCH-CLEANUP ${item} — intent update failed: ${String(error)}`);
			}
		}
		if (childStopped && claimRevision !== undefined) {
			try {
				const released = releaseFailedLaunch(store, {
					project,
					item,
					sid,
					revision: claimRevision,
					nonce,
				});
				log(
					`LAUNCH-CLEANUP ${item} — ${released ? "claim released" : "claim changed; preserved"}`,
				);
			} catch (error) {
				log(
					`LAUNCH-CLEANUP ${item} — configured store release failed: ${String(error)}`,
				);
			}
		}
		if (childStopped && ownedKeyId) {
			try {
				// W615: hub-minted keys revoke AT the minting hub with the hub
				// credential — the local admin cannot revoke them.
				const cred =
					ownedKeyFront !== undefined
						? hubCredential(hub ?? ownedKeyFront)
						: adminKey();
				const revoked = cred
					? await revokeLaneKey(ownedKeyId, cred, fetch, ownedKeyFront)
					: false;
				log(
					`LAUNCH-CLEANUP ${item} — own key ${ownedKeyId} ${revoked ? "revoked" : "revoke failed; TTL bounds it"}`,
				);
			} catch (error) {
				log(`LAUNCH-CLEANUP ${item} — own key revoke failed: ${String(error)}`);
			}
		}
		for (const [path, expected] of ownsFiles && childStopped
			? writtenFiles
			: []) {
			try {
				if (readFileSync(path, "utf8") === expected) rmSync(path);
			} catch {
				/* foreign or absent file is preserved */
			}
		}
	}
	try {
		releaseLaunchLease(store, project, sid, nonce);
	} catch (error) {
		log(`LAUNCH-CLEANUP ${item} — lease release failed: ${String(error)}`);
	}
	store.close();
};
