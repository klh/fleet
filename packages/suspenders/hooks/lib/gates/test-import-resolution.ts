// W1302.7 — test-import resolution canary, scanner half (O4,
// docs/workflow-adjustments-2026-10-25.md). The W1283 reorg left test files
// importing paths/exports that no longer exist: route-preflight.test.ts
// imports `routeInputsByMachine` and the suite dies at load (0 pass).
// This scanner sees every tracked test file at CI time: every RELATIVE
// import must resolve to an existing file, and every imported name must
// still exist in the target's (transitive) export surface — reorg-removed
// paths and exports flip a red guard instead of silently dead suites.
//
// W1302.7.1: lives at a production path (hooks/lib/gates, the
// coverage-proof.ts precedent), NOT under tests/ — the Sinai coverage
// proof restores test-family files after reversing the diff, so a
// tests/-resident scanner rides back in and the proof sees a green
// vacuous run. Here the reversal deletes the scanner while the restored
// guard fails on the missing module: discriminating coverage.
//
// Hybrid parse: Bun.Transpiler.scanImports is ground truth for WHICH
// specifiers a test file imports; per-specifier regexes then extract the
// imported bindings. Export surfaces are regex-extracted and `export *`
// chains resolve transitively with a cycle guard. Parse failures surface
// as rows, never skipped silently. The regexes are deliberately narrow —
// a form they miss is a missed detection, never a false red.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ImportViolationKind =
	| "parse-fail"
	| "missing-target"
	| "missing-export"
	| "empty-surface";

export interface TestImportViolation {
	/** test file, repo-relative */
	file: string;
	/** specifier as written */
	spec: string;
	/** imported binding; undefined = existence-only edge */
	name?: string;
	kind: ImportViolationKind;
}

export interface ScanResult {
	violations: TestImportViolation[];
	/** relative import edges actually checked (existence and/or names) */
	edges: number;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Where a specifier may live on disk, in resolution order. Explicit .ts is
 *  the fleet convention; the .js→.ts swap covers TS-style ESM specifiers,
 *  the index forms cover directory modules. */
function targetCandidates(absDir: string, spec: string): string[] {
	const base = resolve(absDir, spec);
	const out = [base, `${base}.ts`, `${base}.tsx`];
	for (const [from, to] of [
		[".js", ".ts"],
		[".mjs", ".mts"],
		[".cjs", ".cts"],
	] as const) {
		if (base.endsWith(from)) out.push(`${base.slice(0, -from.length)}${to}`);
	}
	out.push(join(base, "index.ts"), join(base, "index.tsx"));
	return out;
}

/** First candidate that exists on disk, or undefined. Query suffixes
 *  (`./x.ts?bust=1`, a cache-bypass idiom) strip before resolution — the
 *  Bun runtime resolves the path part only. */
export function resolveTarget(
	absDir: string,
	spec: string,
): string | undefined {
	const pathPart = spec.split("?")[0];
	for (const c of targetCandidates(absDir, pathPart))
		if (existsSync(c)) return c;
	return undefined;
}

/** Copy a quoted literal starting at i; return [text, nextIndex]. Template
 *  literals close at the next unescaped backtick — `${}` interiors ride
 *  along verbatim, which only ever costs missed detections. */
function copyLiteral(src: string, i: number): [string, number] {
	const q = src[i];
	let out = src[i++];
	while (i < src.length && src[i] !== q) {
		if (src[i] === "\\") {
			out += src.slice(i, i + 2);
			i += 2;
		} else {
			out += src[i];
			i++;
		}
	}
	if (i < src.length) {
		out += q;
		i++;
	}
	return [out, i];
}

/** Strip // and block comments; string/template literal contents survive
 *  byte-identical via copyLiteral. */
export function stripComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			const [lit, next] = copyLiteral(src, i);
			out += lit;
			i = next;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

interface ImportedBinding {
	name: string;
	/** type-only binding — Bun erases it, never a runtime link risk */
	type: boolean;
}

/** Imported names from a named-clause body: the imported (pre-as) side with
 *  the inline `type X` flag preserved. */
function importedNames(clause: string): ImportedBinding[] {
	const rows: ImportedBinding[] = [];
	for (const item of clause.split(",")) {
		const words = item.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;
		const type = words[0] === "type" && words.length >= 2;
		const first = (type ? words[1] : words[0]) ?? "";
		const name = first.replace(/^["']/, "").replace(/["']$/, "");
		if (IDENT_RE.test(name)) rows.push({ name, type });
	}
	return rows;
}

// Exported (post-as) names: the surface side of export lists.
function exportedNames(clause: string): string[] {
	const rows: string[] = [];
	for (const item of clause.split(",")) {
		const words = item.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;
		const asIdx = words.indexOf("as");
		const raw = asIdx === -1 ? words : words.slice(asIdx + 1);
		const last = raw[raw.length - 1]?.replace(/^["']/, "").replace(/["']$/, "");
		if (last && IDENT_RE.test(last)) rows.push(last);
	}
	return rows;
}

export interface ModuleSurface {
	names: Set<string>;
	/** true when the module or a star chain failed to read */
	broken?: boolean;
}

const surfaceCache = new Map<string, ModuleSurface>();

/** The export surface of one module: regex-extracted local declarations,
 *  named lists (as-side), `export default`, and `export * from` chains
 *  resolved transitively with a cycle guard (pre-seeded cache). */
export function moduleSurface(absPath: string): ModuleSurface {
	const cached = surfaceCache.get(absPath);
	if (cached) return cached;
	const out: ModuleSurface = { names: new Set(), broken: false };
	surfaceCache.set(absPath, out);
	if (!existsSync(absPath)) {
		out.broken = true;
		return out;
	}
	const src = stripComments(readFileSync(absPath, "utf8"));
	const declRe =
		/\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;
	for (const m of src.matchAll(declRe)) out.names.add(m[1]);
	if (/\bexport\s+default\b/.test(src)) out.names.add("default");
	for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
		for (const n of exportedNames(m[1])) out.names.add(n);
	for (const m of src.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
		const target = resolveTarget(dirname(absPath), m[1]);
		if (!target) continue;
		const sub = moduleSurface(target);
		for (const n of sub.names) out.names.add(n);
		if (sub.broken) out.broken = true;
	}
	return out;
}

export interface ClauseEdges {
	default?: string;
	named: string[];
	namespace?: string;
	sideEffect: boolean;
}

const REGEX_METAS = "\\.^$|?*+()[]{}";

/** Regex-escape a specifier for embedding in a clause regexp. */
export function specEsc(spec: string): string {
	let out = "";
	for (const ch of spec) {
		if (REGEX_METAS.includes(ch) || ch === "/") out += ["\\", ch].join("");
		else out += ch;
	}
	return out;
}

/** The import forms one specifier rides, extracted per-specifier from
 *  comment-stripped source. The clause body class cannot span a second
 *  statement (no quotes, no semicolons), so a later from-clause never
 *  poisons an earlier match. */
export function importEdgesFor(src: string, spec: string): ClauseEdges {
	const esc = specEsc(spec);
	const out: ClauseEdges = { named: [], sideEffect: false };
	const clauseRe = new RegExp(
		`\\bimport\\s+(type\\s+)?([^"';]*?)\\s*from\\s*["']${esc}["']`,
		"g",
	);
	for (const m of src.matchAll(clauseRe)) {
		const clauseType = m[1] !== undefined;
		const body = m[2].trim();
		if (clauseType) continue; // whole clause erased — no runtime link
		const ns = body.match(/^\*\s*as\s+([A-Za-z_$][\w$]*)$/);
		if (ns) {
			out.namespace = ns[1];
			continue;
		}
		const list = body.match(/\{([^}]*)\}/);
		if (list) {
			const pre = body
				.slice(0, body.indexOf("{"))
				.trim()
				.replace(/,$/, "")
				.trim();
			if (pre && !/^type\s/.test(pre)) out.default = pre;
			for (const b of importedNames(list[1]))
				if (!b.type) out.named.push(b.name);
		} else if (!/^type\s/.test(body)) {
			out.default = body;
		}
	}
	const sideRe = new RegExp(`\\bimport\\s*["']${esc}["']`);
	const dynRe = new RegExp(`\\bimport\\s*\\(\\s*["']${esc}["']`);
	if (sideRe.test(src) || dynRe.test(src)) out.sideEffect = true;
	return out;
}

/** Scan test files (repo-relative) for relative imports that do not resolve
 *  or name something the target no longer exports. Non-relative specifiers
 *  are out of scope (npm/node/bare — the import-law guard owns those). */
export function checkTestImports(root: string, files: string[]): ScanResult {
	const violations: TestImportViolation[] = [];
	let edges = 0;
	for (const file of files) {
		const abs = join(root, file);
		let src: string;
		try {
			src = readFileSync(abs, "utf8");
		} catch {
			violations.push({ file, spec: "", kind: "parse-fail" });
			continue;
		}
		let specs: { path: string }[];
		try {
			specs = transpiler.scanImports(src.replace(/^#![^\n]*/, "")) as {
				path: string;
			}[];
		} catch {
			violations.push({ file, spec: "", kind: "parse-fail" });
			continue;
		}
		const clean = stripComments(src);
		for (const { path: spec } of specs) {
			if (!spec.startsWith(".")) continue;
			edges++;
			const target = resolveTarget(dirname(abs), spec);
			if (!target) {
				violations.push({ file, spec, kind: "missing-target" });
				continue;
			}
			const surface = moduleSurface(target);
			const clause = importEdgesFor(clean, spec);
			if (clause.default !== undefined && !surface.names.has("default"))
				violations.push({
					file,
					spec,
					name: clause.default,
					kind: "missing-export",
				});
			if (clause.namespace !== undefined && surface.names.size === 0)
				violations.push({
					file,
					spec,
					name: clause.namespace,
					kind: "empty-surface",
				});
			for (const name of clause.named)
				if (!surface.names.has(name))
					violations.push({ file, spec, name, kind: "missing-export" });
		}
	}
	return { violations, edges };
}

/** Tracked test-family files (repo-relative) — git ls-files so scratch and
 *  .worktrees cannot red the guard. */
export function collectTestFiles(root: string): string[] {
	const out = Bun.spawnSync(
		["git", "ls-files", "*.test.ts", "*.test.tsx", "*.spec.ts", "*.bench.ts"],
		{ cwd: root },
	);
	if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
	return new TextDecoder()
		.decode(out.stdout)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Deterministic pin key for the guard's dead-import allowlist. */
export function renderViolation(v: TestImportViolation): string {
	const detail = v.name ?? v.kind;
	return `${v.file} -> ${v.spec} (${detail})`;
}
