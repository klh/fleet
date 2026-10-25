// p1-package-contract.test.ts — W1303.1.2: belt's package manifest conforms
// to the P1 contract (explicit exports/bin maps, files allowlist, exact
// dependency pins, engines line). Scoped belt-only check; the repo-wide
// check-versions/check-deps/check-pack law guards land with W1303.1 and
// supersede nothing here — belt stays provable alone.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PKG = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

const EXACT_PIN = /^\d+\.\d+\.\d+$/;

describe("p1 package contract (@klh/belt)", () => {
	test("manifest parses as JSON with the @klh/belt name", () => {
		expect(manifest.name).toBe("@klh/belt");
		expect(manifest.type).toBe("module");
	});

	test("engines line present (bun)", () => {
		expect(manifest.engines?.bun).toBeString();
		expect(manifest.engines.bun.length).toBeGreaterThan(0);
	});

	test("files allowlist present and ships no tests", () => {
		expect(Array.isArray(manifest.files)).toBeTrue();
		expect(manifest.files).toContain("bin");
		expect(manifest.files).not.toContain("test");
		expect(manifest.files.join(" ")).not.toContain("test/");
	});

	test("exports map explicit; every target resolves on disk", () => {
		expect(Object.keys(manifest.exports).length).toBeGreaterThan(0);
		for (const [key, target] of Object.entries<string>(manifest.exports)) {
			expect(existsSync(join(PKG, target)), `${key} -> ${target}`).toBeTrue();
			expect(key.startsWith("./")).toBeTrue();
		}
		// the blam lane consumes this deep path by package specifier
		expect(manifest.exports["./bench/arena/condense.ts"]).toBeDefined();
	});

	test("bin map covers the runnables; every target resolves on disk", () => {
		expect(Object.keys(manifest.bin).length).toBeGreaterThan(0);
		for (const [key, target] of Object.entries<string>(manifest.bin)) {
			expect(existsSync(join(PKG, target)), `${key} -> ${target}`).toBeTrue();
		}
	});

	test("dependency pins exact (no ranges, no workspace: protocol)", () => {
		for (const group of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
		]) {
			for (const [name, spec] of Object.entries<string>(
				manifest[group] ?? {},
			)) {
				expect(spec, name).toMatch(EXACT_PIN);
			}
		}
	});

	test("@klh/blam pin agrees with the workspace sibling version", () => {
		const blam = JSON.parse(
			readFileSync(join(PKG, "../blam/package.json"), "utf8"),
		);
		expect(manifest.dependencies["@klh/blam"]).toBe(blam.version);
	});

	test("no devDependencies left after the yaml removal", () => {
		expect(manifest.devDependencies).toBeUndefined();
	});
});
