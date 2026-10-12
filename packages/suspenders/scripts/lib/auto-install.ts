// auto-install.ts — W638 decision core for com.suspenders.auto-install
// (launchd 300s interval): fleet main moved past the last-installed stamp AND
// the repo volume is mounted AND no lane is live (or of unknown liveness —
// fail closed: the harness sync mutates code running lanes execute, the
// 2026-10-11 outage class). Pure so the launchd entry (scripts/auto-install.ts)
// stays spawn-heavy and this file stays testable.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LaneAuditRow = { sid: string; live: boolean | null };

export type AutoInstallDecision =
	| { action: "install" }
	| { action: "skip"; reason: string };

/** One honest verdict from the guards, in the order the entry evaluates
 * them: volume → git → stamp → lanes. Any "skip" is a waiting state, not an
 * error — the next tick re-evaluates. */
export function decideAutoInstall(input: {
	volumeMounted: boolean;
	/** `git rev-parse main` in the fleet root; null = git failed */
	head: string | null;
	/** last-installed main sha from the stamp; null = never installed */
	stamp: string | null;
	/** `work lanes --json` audit; null = registry unreadable → never install */
	lanes: LaneAuditRow[] | null;
}): AutoInstallDecision {
	if (!input.volumeMounted)
		return { action: "skip", reason: "volume-unmounted" };
	if (input.head === null) return { action: "skip", reason: "git-failed" };
	if (input.stamp === input.head)
		return { action: "skip", reason: "up-to-date" };
	if (input.lanes === null)
		return { action: "skip", reason: "lanes-registry-unreadable" };
	// live or unknown-liveness both block; only a proven-dead/empty lane set
	// authorizes mutating the harness under nobody's feet.
	const notDead = input.lanes.filter((l) => l.live !== false);
	if (notDead.length > 0)
		return {
			action: "skip",
			reason: `lanes-live:${notDead.length}`,
		};
	return { action: "install" };
}

/** Volume guard: a stale automount point (volume unmounted, empty dir left
 * on the boot volume) stats fine but holds nothing — distinguish it from a
 * real mount by device id. Not under /Volumes (or /Volumes itself absent)
 * = no volume dependency = mounted. statFn injection keeps it pure. */
export function isVolumeMounted(
	root: string,
	stat: (path: string) => { dev: number } = (path) => statSync(path),
): boolean {
	try {
		stat(root);
	} catch {
		return false;
	}
	const marker = "/Volumes/";
	if (!root.startsWith(marker)) return true;
	const rest = root.slice(marker.length);
	const slash = rest.indexOf("/");
	if (slash < 0) return true; // root IS the volume mountpoint
	const volume = `${marker}${rest.slice(0, slash)}`;
	try {
		return stat(volume).dev !== stat(dirname(volume)).dev;
	} catch {
		return false;
	}
}

/** The fleet monorepo root from a package path: <root>/packages/suspenders
 * → <root>; anything else is its own root. */
export function fleetRootOf(repo: string): string {
	if (dirname(repo).endsWith("/packages")) return dirname(dirname(repo));
	return repo;
}

export type InstallStamp = { main: string; installedAt: string };

export function readStamp(path: string): InstallStamp | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as InstallStamp;
		return typeof parsed.main === "string" && parsed.main !== ""
			? parsed
			: null;
	} catch {
		return null;
	}
}

export function writeStamp(path: string, main: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ main, installedAt: new Date().toISOString() })}\n`,
	);
}
