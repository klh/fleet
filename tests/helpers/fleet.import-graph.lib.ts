// W1249 — the fleet import graph as data (restructure proposal Phase 1,
// docs/restructure-proposal-2026-10-23.md, Amendment B SAFE NOW: read-only
// + guards, no runtime changes).
//
// One scanner, three consumers: tests/fleet.import-law.guard.test.ts (the
// import-direction law + ratchet), tests/cross-package-imports.test.ts (the
// W649 declaration contract), and docs/fleet.entry-points.map.md
// (regeneration). Checks are pure functions over one scan, so the guard test
// scans the tree once and derives every law from the same data.
//
// Bun.Transpiler.scanImports is the parser (no regex guessing). It throws on
// `#!/usr/bin/env bun` shebangs — strip the shebang before scanning or every
// shebang-led bin/hook file silently drops out of the graph (that hole hid
// speedy's shell-quote phantom in the first scan). Files that STILL fail to
// parse are surfaced, never skipped silently (the guard asserts zero).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type ImportKind =
	| "klh"
	| "builtin"
	| "external"
	| "internal"
	| "reachin";

export interface ImportEdge {
	/** fleet package name: belt, suspenders, kernel, ... */
	sourcePkg: string;
	/** file relative to packages/<sourcePkg>/ */
	file: string;
	/** specifier as written */
	spec: string;
	kind: ImportKind;
	/** fleet package on the far side, when there is one (klh/reachin) */
	targetPkg?: string;
}

export interface PkgScan {
	edges: ImportEdge[];
	/** files the transpiler could not parse — must stay empty */
	parseFails: string[];
}

export interface Manifest {
	deps: Set<string>;
	devDeps: Set<string>;
}

export interface FleetScan {
	root: string;
	pkgs: string[];
	manifests: Map<string, Manifest | null>;
	scans: Map<string, PkgScan>;
}

export interface Phantom {
	pkg: string;
	name: string;
	/** files importing the undeclared name */
	files: string[];
	/** true = imported from a runtime file (must live in "dependencies") */
	runtime: boolean;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Fleet package dirs (no manifest required — local-llm/telemetry scan too). */
export function fleetPackages(root: string): string[] {
	return readdirSync(join(root, "packages")).filter(
		(d) =>
			!d.startsWith(".") &&
			existsSync(join(root, "packages", d)) &&
			readdirSync(join(root, "packages", d), { withFileTypes: true }).some(
				(e) => e.isDirectory() || e.name.endsWith(".ts"),
			),
	);
}

/** @scope/name or the first path segment of a bare specifier. */
export function specName(spec: string): string {
	return spec.startsWith("@")
		? spec.split("/").slice(0, 2).join("/")
		: spec.split("/")[0];
}

/** klh = @klh/* package · builtin = node:/bun: builtins + the bare `bun`
 *  module · external = npm · relative = ./ ../ ./x.ts. */
export function classifySpec(
	spec: string,
): "klh" | "builtin" | "external" | "relative" {
	if (spec.startsWith("@klh/")) return "klh";
	if (spec.startsWith("node:") || spec.startsWith("bun:") || spec === "bun")
		return "builtin";
	if (spec.startsWith(".")) return "relative";
	return "external";
}

/** Test/content position: devDependencies may cover it. Runtime files
 *  (src/hooks/bin/scripts/deploy/ui) require "dependencies". */
export function isDevPosition(file: string): boolean {
	return (
		/(^|\/)(test|tests|bench|fixtures|skills|skills-available)(\/|$)/.test(
			file,
		) || /\.(test|bench)\.ts$/.test(file)
	);
}

function readManifest(root: string, pkg: string): Manifest | null {
	const path = join(root, "packages", pkg, "package.json");
	if (!existsSync(path)) return null;
	const json = JSON.parse(readFileSync(path, "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	return {
		deps: new Set(Object.keys(json.dependencies ?? {})),
		devDeps: new Set(Object.keys(json.devDependencies ?? {})),
	};
}

/** Scan every package once. The base for all checks below. */
export async function scanFleet(root: string): Promise<FleetScan> {
	const pkgs = fleetPackages(root);
	const manifests = new Map<string, Manifest | null>();
	const scans = new Map<string, PkgScan>();
	for (const pkg of pkgs) {
		manifests.set(pkg, readManifest(root, pkg));
		scans.set(pkg, await scanPackage(root, pkg));
	}
	return { root, pkgs, manifests, scans };
}

export async function scanPackage(root: string, pkg: string): Promise<PkgScan> {
	const pkgAbs = join(root, "packages", pkg);
	const pkgsRoot = join(root, "packages");
	const out: PkgScan = { edges: [], parseFails: [] };
	if (!existsSync(pkgAbs)) return out;
	for await (const f of new Bun.Glob("**/*.ts").scan({
		cwd: pkgAbs,
		onlyFiles: true,
	})) {
		if (f.includes("node_modules") || f.includes("vendor/")) continue;
		const src = (await Bun.file(join(pkgAbs, f)).text()).replace(
			/^#![^\n]*/,
			"",
		);
		let imports: { path: string }[];
		try {
			imports = transpiler.scanImports(src) as { path: string }[];
		} catch {
			out.parseFails.push(f);
			continue;
		}
		for (const imp of imports) {
			const spec = imp.path ?? "";
			if (!spec) continue;
			const kind = classifySpec(spec);
			let targetPkg: string | undefined;
			if (kind === "klh") {
				// subpath imports (@klh/blam/src/x.ts) resolve to the package
				targetPkg = spec.split("/")[1];
			} else if (kind === "relative") {
				const target = resolve(dirname(join(pkgAbs, f)), spec);
				if (!target.startsWith(pkgAbs + sep)) {
					targetPkg = target.startsWith(pkgsRoot + sep)
						? relative(pkgsRoot, target).split(sep)[0]
						: "(repo)";
				}
			}
			out.edges.push({
				sourcePkg: pkg,
				file: f,
				spec,
				kind: targetPkg !== undefined && kind === "relative" ? "reachin" : kind,
				targetPkg,
			});
		}
	}
	return out;
}

/** Imports of names the importing package never declared (npm or @klh/*).
 *  Grouped per (package, name, position); sorted for stable asserts. */
export function phantoms(fs: FleetScan): Phantom[] {
	const rows: Phantom[] = [];
	for (const [pkg, manifest] of fs.manifests) {
		if (!manifest) continue;
		const byName = new Map<string, Phantom>();
		for (const e of fs.scans.get(pkg)?.edges ?? []) {
			if (e.kind !== "external" && e.kind !== "klh") continue;
			const name = specName(e.spec);
			if (manifest.deps.has(name) || manifest.devDeps.has(name)) continue;
			const runtime = !isDevPosition(e.file);
			const key = `${name}\u0000${runtime}`;
			const hit = byName.get(key);
			if (hit) hit.files.push(e.file);
			else byName.set(key, { pkg, name, files: [e.file], runtime });
		}
		rows.push(...byName.values());
	}
	return rows.sort(
		(a, b) =>
			a.pkg.localeCompare(b.pkg) ||
			a.name.localeCompare(b.name) ||
			Number(b.runtime) - Number(a.runtime),
	);
}

/** Declared @klh/* deps never imported by the declaring package. */
export function unusedDeclaredKlh(
	fs: FleetScan,
): { pkg: string; name: string }[] {
	const rows: { pkg: string; name: string }[] = [];
	for (const [pkg, manifest] of fs.manifests) {
		if (!manifest) continue;
		const imported = new Set(
			(fs.scans.get(pkg)?.edges ?? [])
				.filter((e) => e.kind === "klh")
				.map((e) => e.specName ?? e.spec)
				.map((s) => specName(s)),
		);
		for (const dep of [...manifest.deps, ...manifest.devDeps]) {
			if (dep.startsWith("@klh/") && !imported.has(dep))
				rows.push({ pkg, name: dep });
		}
	}
	return rows.sort(
		(a, b) => a.pkg.localeCompare(b.pkg) || a.name.localeCompare(b.name),
	);
}

/** Relative imports whose resolved target leaves the source package. */
export function reachIns(fs: FleetScan): ImportEdge[] {
	const edges = [...fs.scans.values()].flatMap((s) => s.edges);
	return edges
		.filter((e) => e.kind === "reachin")
		.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

/** @klh/* cross-package imports (the legal surface). */
export function klhEdges(fs: FleetScan): ImportEdge[] {
	const edges = [...fs.scans.values()].flatMap((s) => s.edges);
	return edges
		.filter((e) => e.kind === "klh")
		.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

/** The kernel law: kernel imports nothing in fleet (no relative reach-in,
 *  no @klh/* import). Vacuously true until packages/kernel exists; the guard
 *  fixture proves the detector. */
export function kernelViolations(fs: FleetScan): ImportEdge[] {
	return klhEdges(fs)
		.concat(reachIns(fs))
		.filter((e) => e.sourcePkg === "kernel")
		.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

/** Stable pin key for a reach-in edge. */
export function edgeKey(e: ImportEdge): string {
	return `${e.sourcePkg}/${e.file} -> ${e.targetPkg} (${e.spec})`;
}
