// W1294.8: ported 1:1 from cross-package-imports.test.ts to @playwright/test (@unit).
// W649 cross-package import guard: every `from "@klh/<pkg>"` (static or
// dynamic) under packages/X must be a DECLARED dependency of X
// (package.json "dependencies"). The installed artifact links only the
// declared graph — an undeclared cross-package import installs clean and
// dies at first run on the hub, so this guard fails the build instead.
// Also pins the known edge set so the scan cannot silently rot to zero
// coverage (a broken regex must fail here, not in production).
import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { klhEdges, scanFleet } from "./helpers/fleet.import-graph.lib.ts";

let fleet = null;

test.beforeAll(async () => {
	fleet = await scanFleet(join(import.meta.dir, ".."));
});

test("the regex scanner and the transpiler lib agree on @klh edges (W1249) @unit", () => {
	// Two independent scanners over one tree: the regex in this file and the
	// Bun.Transpiler scan in the lib must derive the same (source → target)
	// edge set. Disagreement = one of them rotted.
	const lib = new Set(
		klhEdges(fleet).map(
			(e) =>
				`${e.sourcePkg}->${e.targetPkg}:${e.spec.split("/").slice(0, 2).join("/")}`,
		),
	);
	const regex = new Set();
	for (const pkg of readdirSync(
		join(import.meta.dir, "..", "packages"),
	).sort()) {
		if (
			!existsSync(join(import.meta.dir, "..", "packages", pkg, "package.json"))
		)
			continue;
		for (const file of sources(pkg)) {
			for (const m of readFileSync(
				join(import.meta.dir, "..", "packages", pkg, file),
				"utf8",
			).matchAll(/(?:from|import)\s*\(?\s*["'](@klh\/[a-z-]+)/g)) {
				regex.add(`${pkg}->${m[1].split("/")[1]}:${m[1]}`);
			}
		}
	}
	expect(regex).toEqual(lib);
});

const ROOT = join(import.meta.dir, "..");
const PACKAGES = join(ROOT, "packages");

/** Declared @klh/* dependencies of a package, runtime OR dev (empty when
 *  no manifest). Dev-only is legal for checkout-only tooling (blam/tools
 *  benches) — the installed artifact never ships those paths; the shipped
 *  graph itself is proven by the CI artifact-roundtrip job. */
function declared(pkg) {
	const manifest = join(PACKAGES, pkg, "package.json");
	if (!existsSync(manifest)) return new Set();
	const pkgJson = JSON.parse(readFileSync(manifest, "utf8"));
	return new Set(
		Object.keys({
			...pkgJson.dependencies,
			...pkgJson.devDependencies,
		}).filter((d) => d.startsWith("@klh/")),
	);
}

/** All package-local .ts files, node_modules workspace links excluded. */
function sources(pkg) {
	return [
		...new Bun.Glob("**/*.ts").scanSync({
			cwd: join(PACKAGES, pkg),
			onlyFiles: true,
		}),
	].filter((f) => !f.includes("node_modules"));
}

/** @klh/* specifiers imported by a package's own sources. */
function imported(pkg) {
	const found = new Set();
	for (const file of sources(pkg)) {
		const src = readFileSync(join(PACKAGES, pkg, file), "utf8");
		for (const m of src.matchAll(
			/(?:from|import)\s*\(?\s*["'](@klh\/[a-z-]+)/g,
		)) {
			found.add(m[1]);
		}
	}
	return found;
}

test("every cross-package @klh import is declared by the importing package @unit", () => {
	for (const pkg of readdirSync(PACKAGES).sort()) {
		if (!existsSync(join(PACKAGES, pkg, "package.json"))) continue;
		const deps = declared(pkg);
		for (const name of imported(pkg)) {
			expect(
				deps.has(name),
				`packages/${pkg} imports ${name} without declaring it in package.json`,
			).toBe(true);
		}
	}
});

test("every declared @klh dependency exists as a package @unit", () => {
	for (const pkg of readdirSync(PACKAGES).sort()) {
		for (const dep of declared(pkg)) {
			const name = dep.slice("@klh/".length);
			expect(
				existsSync(join(PACKAGES, name, "package.json")),
				`packages/${pkg} declares ${dep} but packages/${name} has no manifest`,
			).toBe(true);
		}
	}
});

test("the guard has teeth: the known cross-package edges are detected @unit", () => {
	// Subset, not equality — new edges may land; a zero or broken scan may not.
	const known = [
		["belt", "blam"],
		["blam", "belt"],
		["blam", "suspenders"],
		["buckle", "blam"],
		["suspenders", "blam"],
	];
	for (const [pkg, dep] of known) {
		expect(
			imported(pkg).has(`@klh/${dep}`),
			`scan lost the known edge ${pkg} -> ${dep}; the import regex rotted`,
		).toBe(true);
	}
});
