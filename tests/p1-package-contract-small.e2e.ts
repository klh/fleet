// tests/p1-package-contract-small.e2e.ts — W1303.1.9: the five small
// packages (speedy blam local local-llm kernel) conform to the P1 package
// contract (explicit exports/files/bin/engines, exact pins, API preserved
// for every name-based cross-package consumer). Tagged @api spec per the
// W1294.1 one-framework ratchet — no new *.test.ts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = process.cwd(); // playwright CLI runs from repo root
const readManifest = (p: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8"));
const EXACT = /^\d+\.\d+\.\d+$/;
const PACKAGES = ["kernel", "local-llm", "local", "speedy", "blam"] as const;

/** Name-based @klh/<pkg>/... specifiers used by any file under packages/ + tests/. */
function crossPackageSpecifiers(pkg: string): string[] {
	const found = new Set<string>();
	const specifiers = new RegExp(`["']@klh/${pkg}/([^"']+)["']`, "g");
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				if (entry === "node_modules" || entry === ".harness") continue;
				walk(path);
			} else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
				for (const m of readFileSync(path, "utf8").matchAll(specifiers))
					// placeholder literals ("@klh/blam/...") in fixtures are not specifiers
					if (/[a-z0-9]/i.test(m[1] ?? "")) found.add(m[1] ?? "");
			}
		}
	};
	walk(join(ROOT, "packages"));
	walk(join(ROOT, "tests"));
	return [...found];
}

const covered = (sub: string, patterns: string[]): boolean =>
	patterns.some((raw) => {
		const pattern = raw.replace("./", "");
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

test.describe({ tag: "@api" }, () => {
	for (const pkg of PACKAGES) {
		const manifest = readManifest(pkg);
		const dir = join(ROOT, "packages", pkg);
		const depGroups = ["dependencies", "devDependencies", "peerDependencies"];

		test(`${pkg}: manifest parses with name, module type, exact engines pin`, () => {
			expect(manifest.name).toBe(`@klh/${pkg}`);
			expect(manifest.type).toBe("module");
			expect((manifest.engines as Record<string, string>).bun).toMatch(EXACT);
		});

		test(`${pkg}: every dependency pin is exact MAJOR.MINOR.PATCH`, () => {
			for (const group of depGroups)
				for (const [name, spec] of Object.entries<string>(
					(manifest[group] ?? {}) as Record<string, string>,
				))
					expect(spec, `${group}/${name}`).toMatch(EXACT);
		});

		test(`${pkg}: exports map explicit; every target resolves on disk`, () => {
			const exportsMap = manifest.exports as Record<string, string>;
			expect(Object.keys(exportsMap).length).toBeGreaterThan(0);
			for (const [key, target] of Object.entries(exportsMap)) {
				expect(key.startsWith("./"), key).toBe(true);
				// wildcard targets resolve via their directory prefix: ./src/* -> src/
				const probe = target.endsWith("/*") ? target.slice(0, -2) : target;
				expect(existsSync(join(dir, probe)), `${key} -> ${target}`).toBe(true);
			}
		});

		test(`${pkg}: exports cover every name-based cross-package import (API preserved)`, () => {
			const patterns = Object.keys(manifest.exports as Record<string, string>);
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
			const files = manifest.files as string[];
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
			const bin = (manifest.bin ?? {}) as Record<string, string>;
			const runnables: Record<string, string[]> = {
				kernel: [],
				"local-llm": ["lane-load-bench"],
				local: ["klh-local", "dashboard"],
				speedy: ["install-fleet", "quiet-output"],
				blam: ["blam-label"],
			};
			expect(Object.keys(bin).sort()).toEqual(runnables[pkg].sort());
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
		const devDeps = blam.devDependencies as Record<string, string>;
		for (const sibling of ["belt", "buckle", "suspenders"]) {
			expect(devDeps[`@klh/${sibling}`]).toBe(
				(readManifest(sibling).version as string) ?? "",
			);
		}
		// and the exact-pin law holds for the suspenders -> blam direction too
		const suspenders = readManifest("suspenders");
		expect(
			(suspenders.dependencies as Record<string, string>)["@klh/blam"],
		).toBe(blam.version);
	});

	test("speedy: dead yaml dependency is gone (W1253 law: JSON only)", () => {
		const speedy = readManifest("speedy");
		const deps = {
			...(speedy.dependencies as Record<string, string>),
			...(speedy.devDependencies as Record<string, string>),
		};
		expect(deps.yaml).toBeUndefined();
		expect(deps["shell-quote"]).toBe("1.12.0");
	});
});
