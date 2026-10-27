// test/package-contract.test.ts — W1303.1.10: @klh/telemetry P1 package
// contract (paas standard principles 10-11, via W1301 disposition row 3): the
// manifest declares explicit exports/files/engines with no dependency rows to
// pin (kernel-shaped: zero deps), the exports map covers every module any
// other package reach-ins into, and the shared seam keeps its sync-harness
// SOURCE_PATHS row so installed prefixes keep stamping.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PKG_DIR = join(import.meta.dir, "..");
const manifest = JSON.parse(
	readFileSync(join(PKG_DIR, "package.json"), "utf8"),
) as Record<string, unknown>;
const exportsMap = (manifest.exports ?? {}) as Record<string, string>;
const filesList = (manifest.files ?? []) as string[];
const engines = (manifest.engines ?? {}) as Record<string, string>;

/** Every file under src/ — the runtime surface the manifest must ship. */
function srcModules(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (entry.endsWith(".ts")) found.push(path);
		}
	};
	walk(join(PKG_DIR, "src"));
	return found.map((p) => `.${p.slice(PKG_DIR.length)}`);
}

/**
 * Every relative reach-in from ANOTHER package into telemetry src — the
 * imports the exports map must keep covering while lanes convert them to
 * declared `@klh/telemetry/*` specifiers (W1303.1.1 pattern).
 */
function crossPackageReachIns(): string[] {
	const found = new Set<string>();
	const reach = /from\s+"[^"]*telemetry\/(src\/[^"']+)"/g;
	const roots = [
		join(PKG_DIR, ".."), // packages/
		join(PKG_DIR, "..", "..", "tests"), // repo-root tests/
	];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				if (
					entry === "node_modules" ||
					entry === ".harness" ||
					entry === "decant"
				)
					continue;
				walk(path);
			} else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
				const rel = path.slice(join(PKG_DIR, "..").length + 1);
				if (rel.startsWith("telemetry/")) continue;
				for (const match of readFileSync(path, "utf8").matchAll(reach))
					found.add(match[1] ?? "");
			}
		}
	};
	for (const root of roots) walk(root);
	return [...found];
}

test("manifest has zero dependency rows to pin", () => {
	expect(Object.keys((manifest.dependencies ?? {}) as object)).toEqual([]);
	expect(Object.keys((manifest.devDependencies ?? {}) as object)).toEqual([]);
});

test("engines pins the bun toolchain exactly", () => {
	expect(engines.bun).toMatch(/^\d+\.\d+\.\d+$/);
});

test("exports covers every src module", () => {
	const modules = srcModules();
	expect(modules.length).toBe(7);
	const keys = Object.keys(exportsMap).map((k) => k.replace("./", ""));
	for (const mod of modules) {
		expect(keys, mod).toContain(mod.replace("./", ""));
		expect(exportsMap[`./${mod.replace("./", "")}`]).toBe(mod);
	}
	// the bare-package face the README documents
	expect(exportsMap["."]).toBe("./src/index.ts");
});

test("files allowlist ships exactly the runtime tree, never tests", () => {
	expect(filesList).toEqual(["src", "README.md"]);
	expect(statSync(join(PKG_DIR, "src")).isDirectory()).toBe(true);
	for (const banned of ["test", "e2e", "bench", "docs"]) {
		expect(filesList).not.toContain(banned);
	}
});

test("exports keep covering the cross-package reach-in surface", () => {
	const reachIns = crossPackageReachIns();
	// the scan must see the real seam or it proves nothing
	expect(reachIns.length).toBeGreaterThan(0);
	expect(reachIns).toContain("src/http-trace.ts");
	const keys = Object.keys(exportsMap).map((k) => k.replace("./", ""));
	for (const sub of reachIns) expect(keys, sub).toContain(sub);
});

test("the shared seam still ships with the installer payload", () => {
	// text-scan, not an import: telemetry depends on nothing in fleet (kernel
	// law) and the ratchet would grow an import-law edge for a manifest pin.
	// W1466 made the sync payload the computed import-graph closure — the
	// hand SOURCE_PATHS row this test once pinned is gone. The seam still
	// ships iff a payload face's closure reaches telemetry: assert the
	// entry row AND the import edge, both as literals.
	const syncHarness = readFileSync(
		join(PKG_DIR, "..", "suspenders", "scripts", "sync-harness.ts"),
		"utf8",
	);
	expect(syncHarness).toContain('"packages/belt/bin/dashboard.ts"');
	const dashboard = readFileSync(
		join(PKG_DIR, "..", "belt", "bin", "dashboard.ts"),
		"utf8",
	);
	expect(dashboard).toContain('from "../../telemetry/src/http-trace.ts"');
});
