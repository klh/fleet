// boot-death.ts — W2337: boot-boundary death evidence for unknown-liveness
// claimants. The Oct 30 machine death left claims whose claimant reads
// UNKNOWN on every existing term (stale RUNNING session row, no lane-registry
// entry, no fresh transcript) — W972 session absence never fires because the
// row exists, so `work reclaim <id> --reason crash` refuses forever and
// reclaim-all holds the item eternally. A machine reboot is positive death
// evidence no process survives: if the claimant's session started (or its
// lane-registry row was stamped) BEFORE the current boot AND it holds no
// live process, no fresh transcript and no WS subscribe presence, it cannot
// be alive NOW. Boot identity is the kern.bootsessionuuid (stable across
// sleep/wake — only a reboot changes it); wall-clock kern.boottime is the
// fallback bound. Lookup failure is never death (W51): an unreadable boot
// epoch yields null and the claim stays unknown.
import { hostname } from "node:os";
import type { GovernorStore } from "../govdb/govdb.ts";
import { sameMachine } from "../host-identity.ts";
import type { LaneRef } from "./lane-liveness.ts";

/** One machine boot incarnation, or null when unobservable. `at` is the
 * wall-clock boot time; `id` the boot-session uuid (null on non-darwin or
 * when sysctl refuses — `at` still bounds). */
export type BootEpoch = { id: string | null; at: number };

const run = (args: string[]): string | null => {
	try {
		const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore" });
		return r.exitCode === 0 ? r.stdout.toString().trim() : null;
	} catch {
		return null;
	}
};

// darwin: { sec = 1793388584, usec = 790889 } — seconds suffice for a bound
const parseBoottime = (raw: string | null): number | null => {
	const m = raw ? /sec\s*=\s*(\d+)/.exec(raw) : null;
	return m ? Number(m[1]) * 1000 : null;
};

let cached: BootEpoch | null | undefined;

/** The current boot incarnation, memoized for the process lifetime — the
 * uuid is stable while the machine is up (it names THIS boot). */
export function bootEpoch(): BootEpoch | null {
	if (cached !== undefined) return cached;
	const uuid =
		process.platform === "darwin"
			? run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"])
			: null;
	const at =
		parseBoottime(run(["/usr/sbin/sysctl", "-n", "kern.boottime"])) ??
		(process.platform === "linux"
			? (() => {
					const b = run(["cat", "/proc/stat"]);
					const m = b ? /^btime (\d+)/m.exec(b) : null;
					return m ? Number(m[1]) * 1000 : null;
				})()
			: null);
	if (uuid === null && at === null) {
		cached = null; // unobservable — never death evidence
		return null;
	}
	cached = { id: uuid, at: at ?? Number.NaN };
	return cached;
}

/** Test/probe seam: reset the memo so an injected epoch re-reads. */
export const resetBootEpoch = (): void => {
	cached = undefined;
};

/** A process born in a boot BEFORE the current one cannot exist now. The
 * registry/intent `launchedAt` (ms) and the session `started_at` both bound
 * from above; a lane launched before the boot died with it. */
export const predatesBoot = (epoch: BootEpoch, at: number): boolean =>
	Number.isFinite(epoch.at) && at > 0 && at < epoch.at;

/** WS presence: a live `coord subscribe --as <sid>` socket is liveness the
 * process table may miss (it vouches from outside the claimant). */
const wsPresent = (sid: string): boolean => {
	if (!sid) return false;
	try {
		return (
			Bun.spawnSync([
				"/usr/bin/pgrep",
				"-f",
				`coord[.]ts subscribe --as ${sid}$`,
			]).exitCode === 0
		);
	} catch {
		return false;
	}
};

export type BootDeathQuery = {
	/** the claimant sid — presence probes it even without a registry row */
	sid: string;
	/** session row (RUNNING) of the claimant, when one exists */
	session: { started_at: number; state: string } | null;
	/** the claimant's lane-registry row, when one exists */
	lane?: LaneRef;
	/** W2337 test seam — overrides the machine probe */
	epoch?: BootEpoch | null;
	/** W2337 test seam — overrides the pgrep presence probe */
	presence?: (sid: string) => boolean;
};

/** Positive boot-boundary death evidence for an otherwise-unknown claimant.
 * dead requires EVERY term: (1) a same-host boot epoch is observable, (2)
 * the claimant provably started before it (session row and/or registry row),
 * (3) no WS subscribe presence. Terms 1/2 failing are LOOKUP failures —
 * null, never death (W51). The caller has already established no live
 * process + no fresh transcript + no transport traffic (verdict unknown). */
export function claimantPreBootDeath(
	q: BootDeathQuery,
): { dead: true; why: string } | { dead: false; why: null } | null {
	const epoch = q.epoch !== undefined ? q.epoch : bootEpoch();
	if (!epoch) return null;
	const present = q.presence ?? wsPresent;
	const stamps: string[] = [];
	if (q.session && predatesBoot(epoch, q.session.started_at))
		stamps.push(
			`session started ${new Date(q.session.started_at).toISOString()}`,
		);
	if (q.lane?.launchedAt && predatesBoot(epoch, q.lane.launchedAt))
		stamps.push(`lane launched ${new Date(q.lane.launchedAt).toISOString()}`);
	if (stamps.length === 0) return { dead: false, why: null };
	// a foreign-host registry row never bounds the local boot — its machine
	// may not have rebooted at all
	if (q.lane?.host && !sameMachine(q.lane.host, hostname())) return null;
	if (q.sid && present(q.sid)) return { dead: false, why: null };
	return {
		dead: true,
		why: `claimant pre-dates boot${epoch.id ? ` ${epoch.id.slice(0, 8)}` : ""} (${stamps.join("; ")})`,
	};
}

/** Session-row read for the boot probe — one query, caller-shaped. */
export function readSessionStamp(
	store: GovernorStore,
	sid: string,
): { started_at: number; state: string } | null {
	if (!sid) return null;
	try {
		return (
			(store
				.query("SELECT started_at, state FROM sessions WHERE sid = ?")
				.get(sid) as { started_at: number; state: string } | null) ?? null
		);
	} catch {
		return null;
	}
}
