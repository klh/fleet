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
import { parseLawExpr } from "./repo-laws.ts";
import { projectRootOf } from "./govdb.ts";

export type PreferKey = "tag" | "color" | "prefer" | "must";

export const PREFER_KEYS: readonly PreferKey[] = [
	"tag",
	"color",
	"prefer",
	"must",
];

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
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/i;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const emptyResolved = (): ResolvedPrefer => ({
	tag: null,
	color: null,
	prefer: null,
	must: null,
	sources: {},
	errors: [],
});

const stripQuotes = (raw: string): string => {
	const open = raw.indexOf('"');
	if (open < 0) return raw.trim(); // unquoted tolerated
	const close = raw.indexOf('"', open + 1);
	// quoted value = between the quote pair; anything after it (e.g. a
	// trailing `# comment`) is outside the value and ignored
	return close < 0 ? raw.slice(open + 1).trim() : raw.slice(open + 1, close);
};

/** Parse one .prefer file: first valid definition per key wins; later
 *  duplicates are collected as errors. Values are double-quoted by canon
 *  (unquoted tolerated). Unknown keys and per-key validation failures
 *  (tag shape, RGBHEX color, W96 routing expr) are loud, non-fatal. */
export function parsePreferFile(
	path: string,
	text: string,
): { values: Partial<Record<PreferKey, string>>; errors: string[] } {
	const values: Partial<Record<PreferKey, string>> = {};
	const errors: string[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i]?.trim() ?? "";
		if (!t || t.startsWith("#")) continue;
		const n = i + 1;
		const eq = t.indexOf("=");
		const key = (eq < 0 ? "" : t.slice(0, eq)).trim();
		const raw = eq < 0 ? "" : t.slice(eq + 1).trim();
		const at = `${path}:${String(n)}`;
		if (!PREFER_KEYS.includes(key as PreferKey)) {
			errors.push(
				`${at}: unknown key '${t.slice(0, 24)}' — expected tag, color, prefer, must`,
			);
			continue;
		}
		const k = key as PreferKey;
		const val = stripQuotes(raw);
		if (val === "") {
			errors.push(`${at}: ${k}= needs a "value"`);
			continue;
		}
		if (values[k] !== undefined) {
			errors.push(`${at}: ${k}= set more than once (first wins)`);
			continue;
		}
		if (k === "tag" && !TAG_RE.test(val)) {
			errors.push(
				`${at}: tag must be 1–32 chars [a-z0-9-], got '${val.slice(0, 24)}'`,
			);
			continue;
		}
		if (k === "color" && !COLOR_RE.test(val)) {
			errors.push(
				`${at}: color must be RGBHEX #RRGGBB, got '${val.slice(0, 24)}'`,
			);
			continue;
		}
		if (k === "prefer" || k === "must") {
			const v = parseLawExpr(val);
			if (!v.ok) {
				errors.push(`${at}: ${k}=: ${v.why}`);
				continue;
			}
		}
		values[k] = val;
	}
	return { values, errors };
}

/** Walk upward from startDir collecting .prefer definitions — nearest file
 *  wins per key; the walk stops early once all four keys are known. */
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
		if (PREFER_KEYS.every((k) => out[k] !== null)) break;
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
