// hooks/lib/prefer.ts — W517: .prefer tree tags + colors + soft routing.
// A .prefer file sits at any directory and covers EVERYTHING under it —
// repos, worktrees, plain trees. Resolution walks upward from a path with
// git-config semantics: nearest definition wins PER KEY, so a repo can
// override just its color and inherit the tree's tag. Unlike .llm
// (repo-laws.ts) the walk does NOT stop at the repo root — tree-level
// tagging is meant to cross repo boundaries (icomdev/.prefer tags every
// repo under icomdev).
//
// Grammar (one key per line, '#' comments, blank lines skipped):
//   tag = "ikea"          work-graph tag stamped on items added in the tree
//   color = "#0058A3"     RGBHEX — lane-card border + task-list dot
//   prefer = "ikea llms"  soft routing constraint (W96 expr; W518 consumes)
//   must = "..."          hard routing constraint (same grammar)
// Invalid lines are collected LOUDLY with file:line but never blank the
// whole doc — a color typo must not untag the tree's work items.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectRootOf } from "./govdb/govdb.ts";
import {
	parsePreferFile,
	PREFER_KEYS,
	type PreferKey,
} from "./prefer-parse.ts";
export {
	parsePreferFile,
	PREFER_KEYS,
	TAG_RE,
	type PreferKey,
} from "./prefer-parse.ts";

export interface ResolvedPrefer {
	tag: string | null;
	color: string | null;
	prefer: string | null;
	must: string | null;
	/** key → the .prefer file whose definition won the walk (nearest) */
	sources: Partial<Record<PreferKey, string>>;
	/** "<file>:<line>: why" — loud, non-fatal; valid lines still resolve */
	errors: string[];
}

const FILE = ".prefer";
const MAX_WALK = 64; // depth cap — never walk into a symlink farm

const emptyResolved = (): ResolvedPrefer => ({
	tag: null,
	color: null,
	prefer: null,
	must: null,
	sources: {},
	errors: [],
});

/** Walk upward from startDir collecting .prefer definitions — nearest file
 *  wins per key; validate outer JSON even when all legacy keys are known. */
export function resolvePrefer(startDir: string): ResolvedPrefer {
	const out = emptyResolved();
	let dir = startDir;
	for (let i = 0; i < MAX_WALK; i++) {
		const f = join(dir, FILE);
		if (existsSync(f)) {
			let text = "";
			try {
				text = readFileSync(f, "utf8");
			} catch (e) {
				out.errors.push(`${f}: unreadable: ${String(e)}`);
			}
			const { values, errors } = parsePreferFile(f, text);
			out.errors.push(...errors);
			for (const k of PREFER_KEYS)
				if (out[k] === null && values[k] !== undefined) {
					out[k] = values[k];
					out.sources[k] = f;
				}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

/** The tag alone — the work-add stamping path needs nothing else. */
export const preferTagFor = (dir: string): string | null =>
	resolvePrefer(dir).tag;

// ─── project-key convenience (board read path) ─────────────────────────────
// The board resolves per ROW every 1s poll, so results are cached per
// project root behind a short TTL — .prefer edits apply within seconds
// without a stat-walk per task per poll.
const CACHE_TTL = 5_000;
const cache = new Map<string, { at: number; res: ResolvedPrefer }>();

/** Resolve .prefer for a work-graph project KEY (the git common dir); the
 *  walk starts at the checkout root above it. */
export function preferForProject(project: string): ResolvedPrefer {
	const root = projectRootOf(project);
	const hit = cache.get(root);
	if (hit && Date.now() - hit.at < CACHE_TTL) return hit.res;
	const res = resolvePrefer(root);
	if (cache.size > 128) cache.clear();
	cache.set(root, { at: Date.now(), res });
	return res;
}
