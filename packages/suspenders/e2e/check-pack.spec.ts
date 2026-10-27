// e2e/check-pack.spec.ts — W1303.1.8: the scratch-pack guard's teeth.
// Two layers: synthetic fixtures prove the detectors (parent-path escape,
// unresolved dep, missing export target, stray tarball) against temp trees,
// and one real-chain leg runs the CLI --only kernel end to end (real
// `bun pm pack`, real scratch tarball install, real graph scan) asserting
// the green path and that the run leaves zero tarball strays behind.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	BIN_SKIP,
	type Finding,
	REPO_ROOT,
	binPass,
	checkExportsMap,
	checkInstallGraph,
	findStrayTarballs,
	fleetPackages,
	siblingClosure,
} from "../scripts/check-pack.ts";

test.describe({ tag: "@pack" }, () => {
	const kinds = (findings: readonly Finding[]): string[] =>
		findings.map((f) => f.kind);

	// a synthetic install: node_modules/@klh/x is the package under proof,
	// sibling deps live under node_modules like a real bun install lays out
	const synthTree = (): {
		root: string;
		pkgRoot: string;
		resolveBare: (spec: string, fromDir: string) => string;
	} => {
		const root = mkdtempSync(join(tmpdir(), "check-pack-spec-"));
		const pkgRoot = join(root, "node_modules", "@klh", "x");
		mkdirSync(join(pkgRoot, "src"), { recursive: true });
		mkdirSync(join(root, "node_modules", "@dep", "zed"), { recursive: true });
		writeFileSync(join(pkgRoot, "src", "b.ts"), "export const b = 1;\n");
		writeFileSync(join(pkgRoot, "src", "dyn.ts"), "export const d = 1;\n");
		// the escape target EXISTS (like belt→blam in the checkout) but sits
		// outside the package root: root/node_modules/y.ts
		writeFileSync(join(root, "node_modules", "y.ts"), "export const y = 1;\n");
		writeFileSync(
			join(root, "node_modules", "@dep", "zed", "main.ts"),
			"export const z = 1;\n",
		);
		// bare specs need a manifest to resolve (no exports map required)
		writeFileSync(
			join(root, "node_modules", "@dep", "zed", "package.json"),
			`${JSON.stringify({ name: "@dep/zed", main: "main.ts" })}\n`,
		);
		return {
			root,
			pkgRoot,
			resolveBare: (spec, fromDir) => Bun.resolveSync(spec, fromDir),
		};
	};

	test("binPass: exit+clean output passes, timeout and module errors fail", () => {
		// oracle exits 1 with usage — exited cleanly is the contract
		expect(binPass(1, "usage: oracle <verb>").pass).toBe(true);
		expect(binPass(0, "Usage: work").pass).toBe(true);
		expect(binPass(null, "").pass).toBe(false); // ignored --help, served
		expect(
			binPass(1, "error: Module not found '../belt/x.ts'").pass,
		).toBe(false);
	});

	test("checkInstallGraph: parent-path escape and unresolved dep are findings; in-package and node: imports are not", () => {
		const { root, pkgRoot, resolveBare } = synthTree();
		try {
			const src = join(pkgRoot, "src", "a.ts");
			writeFileSync(
				src,
				[
					'import { b } from "./b.ts";',
					'import { y } from "../../../y.ts";',
					'import { z } from "@dep/zed";',
					'import { nope } from "@dep/absent";',
					'import { f } from "node:fs";',
					'const d = await import("./dyn.ts");',
					"",
				].join("\n"),
			);
			const findings = checkInstallGraph(
				root,
				pkgRoot,
				[src],
				resolveBare,
			);
			expect(kinds(findings)).toEqual([
				"parent-path-escape",
				"unresolved-dep",
			]);
			expect(findings[0].detail).toContain("escapes the package root");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("checkInstallGraph: a spec resolving to nothing in the install is a broken import", () => {
		const { root, pkgRoot, resolveBare } = synthTree();
		try {
			const src = join(pkgRoot, "src", "a.ts");
			writeFileSync(src, 'import { gone } from "./gone.ts";\n');
			const findings = checkInstallGraph(root, pkgRoot, [src], resolveBare);
			expect(kinds(findings)).toEqual(["broken-import"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("checkExportsMap: literal targets must ship; pattern bases must exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "check-pack-exports-"));
		try {
			mkdirSync(join(dir, "present"), { recursive: true });
			writeFileSync(join(dir, "present", "a.ts"), "export const a = 1;\n");
			const findings = checkExportsMap(dir, {
				"./ok": "./present/a.ts",
				"./pattern/*": "./present/*",
				"./gone": "./absent/a.ts",
				"./pattern-gone/*": "./absent/*",
				"./weird": 42,
			});
			expect(kinds(findings)).toEqual([
				"exports-missing",
				"exports-missing",
				"exports-shape",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("findStrayTarballs: a .tgz inside a package dir or at the repo root is dirt", () => {
		const dir = mkdtempSync(join(tmpdir(), "check-pack-stray-"));
		try {
			writeFileSync(join(dir, "klh-x-1.0.0.tgz"), "tgz");
			const pkgFindings = findStrayTarballs(
				[{ dir: "x", path: dir }],
				dir,
			);
			expect(kinds(pkgFindings)).toEqual(["stray-tarball", "stray-tarball"]);
			expect(pkgFindings[0].detail).toContain("x/klh-x-1.0.0.tgz");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("siblingClosure over the real fleet enumerates every @klh package by name", () => {
		const closure = siblingClosure(fleetPackages());
		const names = closure.map((c) => c.name).sort();
		for (const want of [
			"@klh/belt",
			"@klh/blam",
			"@klh/buckle",
			"@klh/kernel",
			"@klh/suspenders",
		]) {
			expect(names, `closure must carry ${want}`).toContain(want);
		}
		// the pinned skip set stays shrink-only: exactly the two belt bins
		// that ignore --help and serve (observed 2026-10-26)
		expect(BIN_SKIP).toEqual({ belt: ["m365-serve", "llm-stack"] });
	});

	// The real chain: pack kernel, scratch-install the tarball, prove the
	// installed graph. kernel is dep-free and green today — the leg asserts
	// the green path AND the no-stray contract on the live tree.
	test("real chain: check-pack --only kernel is green and leaves zero tarball strays", () => {
		test.setTimeout(180_000);
		const run = Bun.spawnSync(
			["bun", "scripts/check-pack.ts", "--only", "kernel"],
			{ cwd: join(import.meta.dir, ".."), timeout: 150_000 },
		);
		const out = new TextDecoder().decode(run.stdout ?? new Uint8Array());
		expect(run.exitCode, `${out}`).toBe(0);
		expect(out).toContain("check-pack @klh/kernel: ok");
		// the run must leave the tree exactly as it found it
		const strays = findStrayTarballs(fleetPackages(), REPO_ROOT);
		expect(strays).toEqual([]);
	});
});
