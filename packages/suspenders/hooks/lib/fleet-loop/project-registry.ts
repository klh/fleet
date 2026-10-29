// hooks/lib/fleet-loop/project-registry.ts — fork E (hub-of-one): the set of
// repos ONE hub's fleet-loop supervises. The registry is machine conf
// (~/.config/klh/stack.json fleet_loop.projects — config-over-code, repos
// carry placeholders only); `coord project register|unregister|list` is the
// verb surface that edits it (atomic 0600 writes through the kernel helper).
//
// The loop's own --repo is always the PRIMARY project (back-compat: no
// registry ⇒ exactly the single-repo loop of before); registry rows join it,
// deduplicated by canonical project identity (git-common-dir), so a row
// naming the primary repo only contributes its sub-cap.
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonConfEither, writeJsonConf } from "../kernel-conf.ts";
import { projectIdentity } from "../govdb/govdb.ts";
import {
	type FleetLoopProject,
	FleetLoopConfigSchema,
	FleetLoopProjectSchema,
	STACK_PATH,
} from "../stack-config.ts";

/** One supervised repo, resolved for a cycle. */
export interface SupervisedProject {
	/** canonical project identity — the controller-lease + work-graph key */
	key: string;
	/** the directory cycle children run in (`--repo`) */
	repo: string;
	glob: string;
	ladder?: string;
	dispatch?: string;
	main: string;
	/** per-project sub-cap under the global ceiling */
	cap?: number;
	/** the loop's own --repo: hub-wide sweeps ride this project's cycle */
	primary: boolean;
}

export interface PrimaryFlags {
	repo: string;
	glob: string;
	ladder?: string;
	dispatch?: string;
	main: string;
}

const realOrResolved = (p: string): string => {
	const abs = resolve(p);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
};

/** Primary + enabled registry rows → the cycle's project list. Rows whose
 *  path is missing are skipped with an issue line (never a crash); registry
 *  rows default glob/dispatch to the primary's (the dispatch script is
 *  repo-agnostic — it resolves its repo from cwd), the ladder to a plain
 *  merge (ladders are repo-owner policy, never inherited). */
export function supervisedProjects(
	primary: PrimaryFlags,
	registry: FleetLoopProject[],
	identityOf: (dir: string) => string = projectIdentity,
): { projects: SupervisedProject[]; issues: string[] } {
	const issues: string[] = [];
	const primaryKey = identityOf(primary.repo);
	const out: SupervisedProject[] = [
		{
			key: primaryKey,
			repo: primary.repo,
			glob: primary.glob,
			ladder: primary.ladder,
			dispatch: primary.dispatch,
			main: primary.main,
			primary: true,
		},
	];
	for (const row of registry) {
		if (row.enabled === false) continue;
		const repo = realOrResolved(row.path);
		if (!existsSync(repo)) {
			issues.push(`registry path missing, skipped: ${row.path}`);
			continue;
		}
		let key: string;
		try {
			key = identityOf(repo);
		} catch (e) {
			issues.push(
				`registry path unresolvable, skipped: ${row.path} (${e instanceof Error ? e.message : String(e)})`,
			);
			continue;
		}
		const seen = out.find((p) => p.key === key);
		if (seen) {
			// the primary (or an earlier row) owns the repo; a later row only
			// contributes a sub-cap the first one lacks
			if (seen.cap === undefined && row.lane_target !== undefined)
				seen.cap = row.lane_target;
			continue;
		}
		out.push({
			key,
			repo,
			glob: row.glob ?? primary.glob,
			ladder: row.ladder,
			dispatch: row.dispatch_cmd ?? primary.dispatch,
			main: row.main ?? "main",
			cap: row.lane_target,
			primary: false,
		});
	}
	return { projects: out, issues };
}

// ─── registry edits (coord project register|unregister|list) ─────────────

type RawConf = Record<string, unknown> & {
	fleet_loop?: Record<string, unknown> & { projects?: unknown };
};

const readRaw = (path: string): RawConf => {
	try {
		const raw = readJsonConfEither(path);
		return raw && typeof raw === "object" ? (raw as RawConf) : {};
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("config not found"))
			return {};
		throw e;
	}
};

const rowsOf = (conf: RawConf): FleetLoopProject[] => {
	const parsed = FleetLoopProjectSchema.array().safeParse(
		conf.fleet_loop?.projects ?? [],
	);
	if (!parsed.success)
		throw new Error(
			`fleet_loop.projects is malformed — fix the machine conf first: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		);
	return parsed.data;
};

const writeRows = (
	path: string,
	conf: RawConf,
	rows: FleetLoopProject[],
): void => {
	const fleetLoop = { ...(conf.fleet_loop ?? {}), projects: rows };
	// the whole block re-validates before any byte lands (schema law)
	FleetLoopConfigSchema.parse(fleetLoop);
	writeJsonConf(path, { ...conf, fleet_loop: fleetLoop });
};

/** Same repo = same resolved path, or the same project identity (a row may
 *  name any directory inside the repo). */
const sameRepo = (
	a: string,
	b: string,
	identityOf: (dir: string) => string,
): boolean => {
	const ra = realOrResolved(a);
	const rb = realOrResolved(b);
	if (ra === rb) return true;
	try {
		return identityOf(ra) === identityOf(rb);
	} catch {
		return false;
	}
};

export function listRegistry(path: string = STACK_PATH()): FleetLoopProject[] {
	return rowsOf(readRaw(path));
}

/** Upsert a row (keyed by repo); returns "added" | "updated". */
export function registerProject(
	input: FleetLoopProject,
	opts: { path?: string; identityOf?: (dir: string) => string } = {},
): "added" | "updated" {
	const path = opts.path ?? STACK_PATH();
	const identityOf = opts.identityOf ?? projectIdentity;
	const row = FleetLoopProjectSchema.parse({
		...input,
		path: realOrResolved(input.path),
	});
	if (!existsSync(row.path))
		throw new Error(`register: path does not exist: ${row.path}`);
	const conf = readRaw(path);
	const rows = rowsOf(conf);
	const at = rows.findIndex((r) => sameRepo(r.path, row.path, identityOf));
	if (at >= 0) rows[at] = { ...rows[at], ...row };
	else rows.push(row);
	writeRows(path, conf, rows);
	return at >= 0 ? "updated" : "added";
}

/** Drop the row for a repo; false when no row matched. */
export function unregisterProject(
	repoPath: string,
	opts: { path?: string; identityOf?: (dir: string) => string } = {},
): boolean {
	const path = opts.path ?? STACK_PATH();
	const identityOf = opts.identityOf ?? projectIdentity;
	const conf = readRaw(path);
	const rows = rowsOf(conf);
	const kept = rows.filter((r) => !sameRepo(r.path, repoPath, identityOf));
	if (kept.length === rows.length) return false;
	writeRows(path, conf, kept);
	return true;
}
