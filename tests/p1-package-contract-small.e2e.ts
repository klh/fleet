// tests/p1-package-contract-small.e2e.ts — W1303.1.9: the five small
// packages (speedy blam local local-llm kernel) conform to the P1 package
// contract (explicit exports/files/bin/engines, exact pins, API preserved
// for every name-based cross-package consumer). Tagged @api spec per the
// W1294.1 one-framework ratchet — no new *.test.ts. Spec-shape law: helpers
// and types live in tests/helpers/p1-contract-small.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	covered,
	crossPackageSpecifiers,
	DEP_GROUPS,
	EXACT,
	field,
	list,
	PACKAGES,
	ROOT,
	RUNNABLES,
	readManifest,
} from "./helpers/p1-contract-small.ts";

test.describe("@api", () => {
	for (const pkg of PACKAGES) {
		test(`${pkg}: manifest parses with name, module type, exact engines pin`, () => {
			const manifest = readManifest(pkg);
			expect(manifest.name).toBe(`@klh/${pkg}`);
			expect(manifest.type).toBe("module");
			expect(field(manifest, "engines").bun).toMatch(EXACT);
		});

		test(`${pkg}: every dependency pin is exact MAJOR.MINOR.PATCH`, () => {
			const manifest = readManifest(pkg);
			for (const group of DEP_GROUPS)
				for (const entry of Object.entries(field(manifest, group)))
					expect(entry[1], `${group}/${entry[0]}`).toMatch(EXACT);
		});

		test(`${pkg}: exports map explicit; every target resolves on disk`, () => {
			const dir = join(ROOT, "packages", pkg);
			const exportsMap = field(readManifest(pkg), "exports");
			expect(Object.keys(exportsMap).length).toBeGreaterThan(0);
			for (const entry of Object.entries(exportsMap)) {
				expect(entry[0].startsWith("./"), entry[0]).toBe(true);
				// wildcard targets resolve via their directory prefix: ./src/* -> src/
				const probe = entry[1].endsWith("/*") ? entry[1].slice(0, -2) : entry[1];
				expect(existsSync(join(dir, probe)), `${entry[0]} -> ${entry[1]}`).toBe(
					true,
				);
			}
		});

		test(`${pkg}: exports cover every name-based cross-package import (API preserved)`, () => {
			const patterns = Object.keys(field(readManifest(pkg), "exports"));
			for (const sub of crossPackageSpecifiers(pkg)) {
				// the scan must see blam's real consumers or it proves nothing
				if (pkg === "blam")
					expect([
						"src/condense/tiers.ts",
						"src/condense/engine.ts",
						"src/condense/version.ts",
						"test/fixtures/condense/corpus.ts",
						// suspenders sync-harness fixture literal (W2178 integration)
						"src/fixture.ts",
					]).toContain(sub);
				expect(covered(sub, patterns), sub).toBe(true);
			}
		});

		test(`${pkg}: files allowlist ships the runtime tree, never tests`, () => {
			const dir = join(ROOT, "packages", pkg);
			const files = list(readManifest(pkg), "files");
			expect(files.length).toBeGreaterThan(0);
			for (const entry of files) {
				if (entry.startsWith("!")) continue;
				// globs (*.ts) resolve via their directory prefix
				const probe = entry.includes("*")
					? entry.slice(0, entry.indexOf("*"))
					: entry;
				if (probe) expect(existsSync(join(dir, probe)), entry).toBe(true);
			}
			// the honest invariant: no test suite file ships (blam's test/fixtures
			// is corpus DATA the condense engine consumes, not a suite)
			expect(files).not.toContain("*.test.ts");
			expect(
				files.some((f) => !f.startsWith("!") && f.endsWith(".test.ts")),
				"test files never ship",
			).toBe(false);
		});

		test(`${pkg}: bin map entries exist and are executable faces`, () => {
			const dir = join(ROOT, "packages", pkg);
			const bin = field(readManifest(pkg), "bin");
			expect(Object.keys(bin).sort()).toEqual(RUNNABLES[pkg].sort());
			for (const target of Object.values(bin)) {
				const path = join(dir, target);
				expect(existsSync(path), target).toBe(true);
				const body = readFileSync(path, "utf8");
				expect(
					body.includes("import.meta.main") ||
						body.startsWith("#!/usr/bin/env bun"),
					`${target} is a real runnable`,
				).toBe(true);
			}
		});
	}

	test("blam: @klh sibling pins agree with the workspace versions", () => {
		const blam = readManifest("blam");
		const devDeps = field(blam, "devDependencies");
		for (const sibling of ["belt", "buckle", "suspenders"])
			expect(devDeps[`@klh/${sibling}`]).toBe(readManifest(sibling).version);
		// and the exact-pin law holds for the suspenders -> blam direction too
		expect(field(readManifest("suspenders"), "dependencies")["@klh/blam"]).toBe(
			blam.version,
		);
	});

	test("speedy: dead yaml dependency is gone (W1253 law: JSON only)", () => {
		const speedy = readManifest("speedy");
		const deps = {
			...field(speedy, "dependencies"),
			...field(speedy, "devDependencies"),
		};
		expect(deps.yaml).toBeUndefined();
		expect(deps["shell-quote"]).toBe("1.12.0");
	});
});
