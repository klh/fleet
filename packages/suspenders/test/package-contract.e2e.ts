// test/package-contract.test.ts — W1303.1.3: @klh/suspenders P1 package
// contract (paas standard principles 10-11, via W1301 disposition row 3): the
// manifest declares explicit exports/files/bin/engines and exact pins, the
// exports map covers every name-based cross-package import of the package,
// and the bin map is the same face the installer's PATH shims register.

import { expect, test } from "./pw";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHIM_NAMES, shimTarget } from "../scripts/ensure-shims.ts";

const PKG_DIR = join(import.meta.dir, "..");
const readManifest = (rel: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(PKG_DIR, "..", "..", rel), "utf8")) as Record<
		string,
		unknown
	>;
const manifest = readManifest("packages/suspenders/package.json");
const blam = readManifest("packages/blam/package.json");
const EXACT = /^\d+\.\d+\.\d+$/;
const deps = (manifest.dependencies ?? {}) as Record<string, string>;
const devDeps = (manifest.devDependencies ?? {}) as Record<string, string>;
const exportsMap = (manifest.exports ?? {}) as Record<string, string>;
const filesList = (manifest.files ?? []) as string[];
const binMap = (manifest.bin ?? {}) as Record<string, string>;

/** Every name-based import of @klh/suspenders/... under packages/ + tests/. */
function crossPackageImports(): string[] {
	const found = new Set<string>();
	const specifiers = /["']@klh\/suspenders\/([^"']+)["']/g;
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				if (entry === "node_modules" || entry === ".harness") continue;
				walk(path);
			} else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
				for (const match of readFileSync(path, "utf8").matchAll(specifiers))
					found.add(match[1] ?? "");
			}
		}
	};
	walk(join(PKG_DIR, "..", "..", "packages"));
	walk(join(PKG_DIR, "..", "..", "tests"));
	return [...found];
}

test("manifest pins one exact version for every dependency", () => {
	for (const [name, spec] of [
		...Object.entries(deps),
		...Object.entries(devDeps),
	]) {
		expect(spec, name).toMatch(EXACT);
	}
	// the internal pin must match the sibling workspace's real version
	expect(deps["@klh/blam"]).toBe(blam.version);
});

test("engines pins the bun toolchain exactly", () => {
	const engines = manifest.engines as Record<string, string>;
	expect(engines.bun).toMatch(EXACT);
});

test("exports covers every name-based cross-package import", () => {
	expect(Object.keys(exportsMap).length).toBeGreaterThan(0);
	const imports = crossPackageImports();
	// the scan must see the real consumers or it proves nothing
	expect(imports).toContain("hooks/board/prompt-transform.ts");
	expect(imports).toContain("hooks/lib/starter/starter-artifacts.ts");
	const patterns = Object.keys(exportsMap).map((key) => key.replace("./", ""));
	for (const sub of imports) {
		const covered = patterns.some((pattern) => {
			if (!pattern.includes("*")) return sub === pattern;
			const star = pattern.indexOf("*");
			const head = pattern.slice(0, star);
			const tail = pattern.slice(star + 1);
			return (
				sub.startsWith(head) &&
				sub.endsWith(tail) &&
				sub.length >= head.length + tail.length
			);
		});
		expect(covered, sub).toBe(true);
	}
});

test("files allowlist ships the runtime tree and never tests", () => {
	expect(filesList).toContain("hooks");
	expect(filesList).toContain("scripts");
	expect(filesList).toContain("deploy");
	for (const banned of ["test", "e2e", "bench", "spikes", "docs"]) {
		expect(filesList).not.toContain(banned);
	}
});

test("bin matches the installer's PATH shim face", () => {
	expect(Object.keys(binMap).sort()).toEqual([...SHIM_NAMES].sort());
	for (const name of SHIM_NAMES) {
		const target = binMap[name];
		expect(statSync(join(PKG_DIR, target)).isFile(), target).toBe(true);
		// shimTarget anchors at the installed PREFIX (its bin/ IS hooks/bin);
		// the manifest bin anchors at the package root — same file, two bases.
		expect(shimTarget("", name)).toBe(target.replace("hooks/", ""));
	}
});
