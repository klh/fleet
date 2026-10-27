// scripts/lib/source-closure.ts — W1256.1: the sync-harness payload closure
// (closes the W661 class — a hand-listed ship list drifting from the real
// import graph). The walk shares the belt/bin overlay walker (belt-bin-overlay
// .ts relativeSpecs): static `from`, dynamic import(), side-effect imports.
// The declared payload must COVER the computed closure; anything the graph
// reaches outside the shipped paths is named instead of dying dark at runtime
// (the 2026-10-11 router incident). Since W1466 payloadClosure (below) IS the
// sync-harness ship list, so no declared list is left to drift.
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { relativeSpecs } from "../belt-bin-overlay.ts";

export interface PayloadCoverageReport {
	/** Declared entries that do not exist in the working tree. */
	missing: string[];
	/** Closure members outside the declared payload (repo-relative, sorted). */
	outside: string[];
	/** Every closure member visited (repo-relative, sorted) — the evidence. */
	visited: string[];
}

export interface PayloadCoverageInput {
	/** Absolute repo root the walk is bounded at. */
	repoRoot: string;
	/** Import-graph faces (repo-relative, e.g. packages/suspenders/hooks/gate.ts). */
	entries: string[];
	/** The declared payload (a ship list, e.g. sync-harness sourcePaths). */
	payload: string[];
}

/** True when `rel` equals a payload path or sits under a payload dir. */
export function coveredByPayload(rel: string, payload: string[]): boolean {
	return payload.some((p) => rel === p || rel.startsWith(`${p}/`));
}

/** BFS the real import graph from `entries` (the same walk belt/bin's flat
 *  home overlay does), bounded at repoRoot, and report which members the
 *  declared payload fails to cover. Non-existent repo-internal imports are
 *  ignored (dangling specifiers are not payload — bun tolerates some
 *  extensionless/typo'd forms the walk cannot resolve); a MISSING declared
 *  entry, though, is reported — the payload must name faces that exist. */
export async function payloadCoverage(
	input: PayloadCoverageInput,
): Promise<PayloadCoverageReport> {
	const root = resolve(input.repoRoot);
	const seen = new Set<string>();
	const outside = new Set<string>();
	const missing = input.entries.filter(
		(rel) => !existsSync(resolve(root, rel)),
	);
	const queue = input.entries.filter((rel) => !missing.includes(rel));
	while (queue.length > 0) {
		const relEntry = queue.shift() as string;
		if (seen.has(relEntry)) continue;
		seen.add(relEntry);
		const abs = resolve(root, relEntry);
		if (!coveredByPayload(relEntry, input.payload)) {
			outside.add(relEntry);
		}
		const source = await Bun.file(abs).text();
		for (const spec of relativeSpecs(source, dirname(abs))) {
			const rel = relative(root, spec);
			if (rel.startsWith("..") || seen.has(rel)) continue;
			// Dangling specifier — not payload (bun tolerates some
			// extensionless/typo'd forms the walk cannot resolve).
			if (!existsSync(resolve(root, rel))) continue;
			queue.push(rel);
		}
	}
	return {
		missing,
		outside: [...outside].sort(),
		visited: [...seen].sort(),
	};
}

// W1466: the payload IS the closure — sync-harness ships what the walk
// computes from its faces, so no hand list exists to drift. Beyond
// relativeSpecs the walk follows the two edge forms the runtime leans on:
// fleet package-name imports (@klh/<pkg>/<sub> → packages/<pkg>/<sub>) and
// module-relative assets (new URL(lit, import.meta.url) and
// join|resolve(import.meta.dir, lit...)).
const PACKAGE_SPEC =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']@klh\/([a-z0-9-]+)\/([^"'?]+)[^"']*["']/g;
const URL_ASSET =
	/\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*,?\s*\)/g;
const DIR_ASSET =
	/\b(?:join|resolve)\(\s*import\.meta\.dir((?:\s*,\s*["'][^"']+["'])+)\s*,?\s*\)/g;
const QUOTED = /["']([^"']+)["']/g;
const SHIPPED_CODE = /\.[cm]?[jt]sx?$/;
const TEST_CODE = /\.(?:test|e2e)\.[cm]?[jt]sx?$|\.d\.ts$/;

const isShippedCode = (rel: string): boolean =>
	SHIPPED_CODE.test(rel) && !TEST_CODE.test(rel);

/** Repo-relative import targets of one module: relativeSpecs plus fleet
 *  package-name imports. */
function codeEdges(source: string, abs: string, root: string): string[] {
	const out = relativeSpecs(source, dirname(abs)).map((spec) =>
		relative(root, spec),
	);
	for (const [, pkg = "", sub = ""] of source.matchAll(PACKAGE_SPEC))
		out.push(`packages/${pkg}/${sub}`);
	return out;
}

/** Repo-relative runtime assets one module addresses from its own dir. */
function assetEdges(source: string, abs: string, root: string): string[] {
	const dir = dirname(abs);
	const out = [...source.matchAll(URL_ASSET)].map(([, lit = ""]) =>
		relative(root, resolve(dir, lit)),
	);
	for (const [, args = ""] of source.matchAll(DIR_ASSET)) {
		const parts = [...args.matchAll(QUOTED)].map(([, lit = ""]) => lit);
		out.push(relative(root, resolve(dir, ...parts)));
	}
	return out;
}

/** The ship unit of a reached module: its package subtree
 *  (packages/<pkg>/<dir> — runtime faces spawn siblings by path, which no
 *  import names), else the file itself at a package root, else its
 *  top-level tree. */
function shipUnit(rel: string): string {
	const segs = rel.split("/");
	if (segs[0] === "packages")
		return segs.length > 3 ? segs.slice(0, 3).join("/") : rel;
	return segs.length > 1 ? (segs[0] ?? rel) : rel;
}

/** Package roots locate a checkout (import.meta.dir joined with ../..) —
 *  anchors, never payload. */
const isAnchor = (rel: string): boolean => /^packages(?:\/[^/]+)?$/.test(rel);

/** Each touched package ships its manifest; a path nested in another
 *  shipped path folds into it — the `git archive` pathspecs. */
function shipList(ship: Set<string>, files: Set<string>): string[] {
	for (const path of [...ship]) {
		const [top, pkg] = path.split("/");
		const manifest = `packages/${pkg}/package.json`;
		if (top === "packages" && pkg && files.has(manifest)) ship.add(manifest);
	}
	const sorted = [...ship].sort();
	return sorted.filter((p) => !sorted.some((q) => p.startsWith(`${q}/`)));
}

export interface PayloadClosureInput {
	/** Absolute repo root the walk is bounded at. */
	repoRoot: string;
	/** Payload faces (repo-relative): graph entrypoints plus trees shipped
	 *  whole by install contract (.githooks). */
	faces: string[];
	/** Every file tracked at the shipped revision — `git archive` carries
	 *  only these, so an edge to anything else is dangling, not payload. */
	tracked: string[];
}

export interface PayloadClosureReport {
	/** Faces absent from the tracked tree. */
	missing: string[];
	/** The ship list (repo-relative, sorted, nesting-free). */
	paths: string[];
	/** Every module the walk read (repo-relative, sorted) — the evidence. */
	visited: string[];
}

/** Every directory holding a tracked file (asset dirs ship only if real). */
function ancestorDirs(files: string[]): Set<string> {
	const dirs = new Set<string>();
	for (const file of files)
		for (let i = file.indexOf("/"); i > 0; i = file.indexOf("/", i + 1))
			dirs.add(file.slice(0, i));
	return dirs;
}

/** Fixed-point closure of `faces`: a reached module ships its unit
 *  (shipUnit) and every module under a shipped unit is walked in turn;
 *  assets ship exactly. The list is closed under the import graph by
 *  construction — the walk is the assertion. */
export async function payloadClosure(
	input: PayloadClosureInput,
): Promise<PayloadClosureReport> {
	const root = resolve(input.repoRoot);
	const files = new Set(input.tracked);
	const dirs = ancestorDirs(input.tracked);
	const ship = new Set<string>();
	const seen = new Set<string>();
	const queue: string[] = [];
	const shipPath = (path: string, walkAll = false): void => {
		if (ship.has(path)) return;
		ship.add(path);
		const members = files.has(path)
			? [path]
			: input.tracked.filter((f) => f.startsWith(`${path}/`));
		for (const f of members) {
			if (seen.has(f) || !(walkAll || isShippedCode(f))) continue;
			seen.add(f);
			queue.push(f);
		}
	};
	const missing = input.faces.filter((f) => !files.has(f) && !dirs.has(f));
	for (const face of input.faces) {
		if (files.has(face)) shipPath(shipUnit(face));
		else if (dirs.has(face)) shipPath(face, true);
	}
	while (queue.length > 0) {
		const rel = queue.shift() as string;
		const abs = resolve(root, rel);
		// Deleted from the working tree: no edges to read — sync-harness's
		// dirty check refuses the deletion before anything ships.
		const source = await Bun.file(abs)
			.text()
			.catch(() => null);
		if (source === null) continue;
		for (const edge of codeEdges(source, abs, root))
			if (files.has(edge)) shipPath(shipUnit(edge));
		for (const asset of assetEdges(source, abs, root))
			if (!isAnchor(asset) && (files.has(asset) || dirs.has(asset)))
				shipPath(asset);
	}
	return { missing, paths: shipList(ship, files), visited: [...seen].sort() };
}
