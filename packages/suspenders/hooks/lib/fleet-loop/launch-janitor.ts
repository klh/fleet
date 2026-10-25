// hooks/lib/fleet-loop/launch-janitor.ts — W1247: the .fleet launch-debris janitor.
// dispatch/supervise fence every lane launch with three files per nonce in
// <REPO>/.fleet — launch-<nonce>.json (descriptor), launch-<nonce>.sh
// (wrapper) and launch-<nonce>.json.registered (executor ack) — and nothing
// ever removed them: the dir held a 6,805-file backlog (2026-10-23). The
// fleet-loop maintenance task (W779) prunes launch-* debris older than
// maxAgeDays UNLESS the nonce is the item's registered-current launch (a
// lane_launch_intents row whose process inspection is not provably dead —
// uncertainty keeps, mirroring heldLaunchItems). Mid-flight launches are
// safe by construction: a PREPARING/REGISTERED row with no provable death
// keeps its file set, so a janitor fire racing a registration never
// strands an executor. Dry-run is the default — without --act nothing is
// removed; the report is the product. The batch is bounded (--max-prune,
// default 5000/fire) and `.fleet/launch-janitor-paused` pauses.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LaunchIntent } from "../../../scripts/lib/launch-fencing.ts";

/** launch-<nonce>.json | launch-<nonce>.sh | launch-<nonce>.json.registered
 *  — the ack alternation must precede the bare json one. */
export const LAUNCH_FILE = /^launch-(.+)\.(json\.registered|json|sh)$/;
/** the retires-paused idiom, scoped to this task */
export const LAUNCH_JANITOR_PAUSE_MARKER = "launch-janitor-paused";

export type LaunchInspect = (
	intent: LaunchIntent,
) => "alive" | "dead" | "unknown";

export interface LaunchJanitorDeps {
	/** the repo the heartbeat serves (dir = <repo>/.fleet) */
	repo: string;
	/** false = dry-run (default): candidates reported, nothing removed */
	act: boolean;
	/** prune only groups whose YOUNGEST file is older than this */
	maxAgeDays: number;
	/** removal cap per fire (default 5000) */
	maxPrune?: number;
	/** launch-<nonce>.* files to consider; default readdirSync(dir) */
	list?: () => string[];
	/** current lane_launch_intents rows (all projects) */
	intents?: () => LaunchIntent[];
	/** liveness verdict for an intent row; default keeps everything */
	inspect?: LaunchInspect;
	/** injectable clock */
	now?: () => number;
	/** directory override (tests); default <repo>/.fleet */
	dir?: string;
}

export interface PrunedRow {
	file: string;
	nonce: string;
	ageDays: number;
}

export interface LaunchJanitorReport {
	dryRun: boolean;
	paused: boolean;
	scanned: number;
	groups: number;
	kept: number;
	keptCurrent: number;
	overflow: number;
	pruned: PrunedRow[];
	errors: string[];
}

const DAY_MS = 86_400_000;

/** nonce → its launch-<nonce>.* files (readdir order preserved). */
export function groupByNonce(files: string[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const file of files) {
		const match = LAUNCH_FILE.exec(file);
		if (!match) continue;
		const nonce = match[1] ?? "";
		const group = groups.get(nonce);
		if (group) group.push(file);
		else groups.set(nonce, [file]);
	}
	return groups;
}

/** The group's YOUNGEST file mtime, or 0 when nothing stats — a set prunes
 *  only when every file in it is stale; never orphan one sibling of a pair. */
export function youngestMtime(dir: string, files: string[]): number {
	let youngest = 0;
	for (const file of files) {
		try {
			const mtime = statSync(join(dir, file)).mtimeMs;
			if (mtime > youngest) youngest = mtime;
		} catch {}
	}
	return youngest;
}

/** A zeroed report for one pass (paused/absent-dir short-circuits return it). */
export function emptyReport(dir: string, act: boolean): LaunchJanitorReport {
	return {
		dryRun: !act,
		paused: existsSync(join(dir, LAUNCH_JANITOR_PAUSE_MARKER)),
		scanned: 0,
		groups: 0,
		kept: 0,
		keptCurrent: 0,
		overflow: 0,
		pruned: [],
		errors: [],
	};
}

/** Remove (act) or just list (dry-run) the stale groups within the batch
 *  bound; overflow groups stay on disk and ride the next fire. */
export function pruneStale(
	dir: string,
	stale: { nonce: string; files: string[]; ageDays: number }[],
	act: boolean,
	maxPrune: number,
	report: LaunchJanitorReport,
): void {
	const bounded = stale.slice(0, maxPrune);
	report.overflow = stale.length - bounded.length;
	for (const entry of bounded) {
		for (const file of entry.files) {
			report.pruned.push({
				file,
				nonce: entry.nonce,
				ageDays: entry.ageDays,
			});
			if (!act) continue;
			try {
				rmSync(join(dir, file));
			} catch (e) {
				report.errors.push(
					`${file}: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
	}
}

/** Split nonce groups into keeps (registered-current or young) and stale. */
export function classifyGroups(
	dir: string,
	groups: Map<string, string[]>,
	current: Map<string, LaunchIntent>,
	inspect: LaunchInspect,
	cutoff: number,
	now: () => number,
): {
	stale: { nonce: string; files: string[]; ageDays: number }[];
	kept: number;
	keptCurrent: number;
} {
	const stale: { nonce: string; files: string[]; ageDays: number }[] = [];
	let kept = 0;
	let keptCurrent = 0;
	for (const [nonce, group] of groups) {
		const row = current.get(nonce);
		if (row && inspect(row) !== "dead") {
			keptCurrent += group.length;
			continue;
		}
		const youngest = youngestMtime(dir, group);
		if (youngest === 0 || youngest > cutoff) {
			kept += group.length;
			continue;
		}
		stale.push({
			nonce,
			files: group,
			ageDays: Math.floor((now() - youngest) / DAY_MS),
		});
	}
	return { stale, kept, keptCurrent };
}

/** One janitor pass over <repo>/.fleet: group launch-* files by nonce, keep
 *  registered-current groups, age out the rest. Dry-run is the default. */
export function createLaunchJanitor(deps: LaunchJanitorDeps): {
	sweep: () => LaunchJanitorReport;
} {
	const now = deps.now ?? ((): number => Date.now());
	const inspect =
		deps.inspect ?? ((): "alive" | "dead" | "unknown" => "unknown");
	const intents = deps.intents ?? ((): LaunchIntent[] => []);
	const dir = deps.dir ?? join(deps.repo, ".fleet");
	const sweep = (): LaunchJanitorReport => {
		const report = emptyReport(dir, deps.act);
		if (report.paused || !existsSync(dir)) return report;
		const files = (deps.list ?? ((): string[] => readdirSync(dir)))().filter(
			(file) => LAUNCH_FILE.test(file),
		);
		report.scanned = files.length;
		const groups = groupByNonce(files);
		report.groups = groups.size;
		const current = new Map<string, LaunchIntent>();
		for (const row of intents()) current.set(row.nonce, row);
		const cutoff = now() - deps.maxAgeDays * DAY_MS;
		const split = classifyGroups(dir, groups, current, inspect, cutoff, now);
		report.kept = split.kept;
		report.keptCurrent = split.keptCurrent;
		pruneStale(dir, split.stale, deps.act, deps.maxPrune ?? 5000, report);
		return report;
	};
	return { sweep };
}
