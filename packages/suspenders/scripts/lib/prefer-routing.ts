// scripts/lib/prefer-routing.ts — W519: .prefer prefer= soft routing,
// must= reserved. Schema (W517 parity): `key = "value"` lines, '#' comments,
// unquoted tolerated; walk-up resolution, nearest definition wins per key —
// tree-level, the walk crosses repo boundaries (icomdev/.prefer covers every
// repo below it, not just one).
//
// Semantics (owner, 2026-10-07): prefer= is a SOFT routing constraint — the
// brief composer notes it and the belt ladder prefers matching endpoints
// when available (W96/W164: prefer ranks by fit, never filters; a repo's
// .llm law stack rides belt /route body.repo). must= is RESERVED — parsed
// and validated with the same W96 grammar, surfaced loud, NOT enforced
// (owner: must becomes a HARD constraint later — the IKEA intel data
// perimeter; IKEA intel lives only in coord facts finding.ikea-*).
//
// tag=/color= belong to the other .prefer planes (W517 work-graph tag,
// W518 board render) — silently not ours. Unknown keys and invalid routing
// expressions fail LOUDLY with file:line but never blank the whole file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLawExpr } from "../../hooks/lib/repo-laws.ts";

export interface PreferRouting {
	/** W96 expr, e.g. "ikea llms" — soft: rank matching endpoints first. */
	prefer: string | null;
	/** W96 expr — RESERVED: validated + surfaced, never enforced today. */
	must: string | null;
	preferSource: string | null;
	mustSource: string | null;
	/** "<file>:<line>: why" — loud, non-fatal; valid keys still resolve. */
	errors: string[];
}

const FILE = ".prefer";
const MAX_WALK = 64; // depth cap — never walk into a symlink farm
const ROUTING_KEYS = new Set(["prefer", "must"]);
// other planes' keys — not a routing concern, never an error here
const FOREIGN_KEYS = new Set(["tag", "color"]);

const emptyRouting = (): PreferRouting => ({
	prefer: null,
	must: null,
	preferSource: null,
	mustSource: null,
	errors: [],
});

/** Quoted value = between the quote pair (trailing `# comment` outside is
 *  ignored); unquoted multi-token values pass through trimmed. */
const stripQuotes = (raw: string): string => {
	const open = raw.indexOf('"');
	if (open < 0) return raw.trim(); // unquoted tolerated
	const close = raw.indexOf('"', open + 1);
	// quoted value = between the quote pair; anything after it (e.g. a
	// trailing `# comment`) is outside the value and ignored
	return close < 0 ? raw.slice(open + 1).trim() : raw.slice(open + 1, close);
};

/** Parse one .prefer file for its ROUTING keys: first valid definition per
 *  key wins; later duplicates are collected as errors. tag/color are
 *  silently ignored (other planes); unknown keys are loud.
 *
 *  Plane split (W519): an UNQUOTED single token is the legacy executor
 *  chain's value shape (must=opus) — not ours. Quoted values (the schema's
 *  key = "value" canon) and multi-token values are routing constraints —
 *  a chain entry carrying a space can only ever pin a garbage model. */
export function parseRoutingPrefer(
	path: string,
	text: string,
): { prefer: string | null; must: string | null; errors: string[] } {
	const out = { prefer: null, must: null, errors: [] };
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i]?.trim() ?? "";
		if (!t || t.startsWith("#")) continue;
		const n = i + 1;
		const eq = t.indexOf("=");
		const key = (eq < 0 ? "" : t.slice(0, eq)).trim();
		const raw = eq < 0 ? "" : t.slice(eq + 1).trim();
		if (!raw.startsWith('"') && !/\s/.test(raw)) continue; // executor plane
		const at = `${path}:${String(n)}`;
		if (FOREIGN_KEYS.has(key)) continue; // W517/W518 planes
		if (!ROUTING_KEYS.has(key)) {
			out.errors.push(
				`${at}: unknown key '${t.slice(0, 24)}' — expected prefer, must (tag/color are other planes)`,
			);
			continue;
		}
		const val = stripQuotes(raw);
		if (val === "") {
			out.errors.push(`${at}: ${key}= needs a "value"`);
			continue;
		}
		if (out[key] !== null) {
			out.errors.push(`${at}: ${key}= set more than once (first wins)`);
			continue;
		}
		const v = parseLawExpr(val);
		if (!v.ok) {
			out.errors.push(`${at}: ${key}=: ${v.why}`);
			continue; // invalid never resolves — no silent guess
		}
		out[key] = val;
	}
	return out;
}

/** Walk upward from startDir collecting routing definitions — nearest
 *  definition wins per key; the walk stops early once both keys are known. */
export function resolveRoutingPrefer(startDir: string): PreferRouting {
	const out = emptyRouting();
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
			const r = parseRoutingPrefer(f, text);
			out.errors.push(...r.errors);
			if (out.prefer === null && r.prefer !== null) {
				out.prefer = r.prefer;
				out.preferSource = f;
			}
			if (out.must === null && r.must !== null) {
				out.must = r.must;
				out.mustSource = f;
			}
		}
		if (out.prefer !== null && out.must !== null) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

/** The brief composer's note (W519): a soft constraint travels with every
 *  lane dispatched in a covered tree — the lane passes repo + hint on belt
 *  /route calls and the ladder ranks matching endpoints first; it never
 *  blocks. must= is disclosed as reserved, not enforced. */
export function preferRoutingBriefLines(r: PreferRouting): string[] {
	const lines: string[] = [];
	if (r.prefer !== null)
		lines.push(
			`ROUTING: .prefer prefer="${r.prefer}" (SOFT — belt ladder prefers matching endpoints when available: pass repo + hint "prefer ${r.prefer}" on belt /route calls; no fit degrades by policy, never blocks)`,
		);
	if (r.must !== null)
		lines.push(
			`ROUTING: .prefer must="${r.must}" (RESERVED — recognized, NOT enforced today; owner hard-constraint lands later)`,
		);
	return lines;
}
