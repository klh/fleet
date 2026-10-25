// coverage-proof.test.ts — W1262: the Sinai coverage-proof classifier must
// accept a scratch "Cannot find module" that names a diff-ADDED module (the
// W1258 regression: the reversed change is what provides the module, so the
// failure IS the proof), and still classify a genuinely missing dependency as
// environmental. Unit faces ride captured real bun error lines; the
// integration face replays the exact coverageProof mechanics (reverse the
// full diff, restore the new tests, bun test in the scratch tree).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	TEST_FILE,
	missingImports,
	missingImportsExplained,
} from "../hooks/lib/gates/coverage-proof.ts";

setDefaultTimeout(60_000);

const roots: string[] = [];

const W = (p: string, s: string): void => {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, s);
};

const git = (args: string[], cwd: string): string => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString();
};

// one fresh temp repo whose whole diff = ADD pkg/mod.ts + ADD pkg/mod.test.ts;
// the returned tree is AFTER the coverageProof reversal (module gone, new test
// restored) — bun test there reproduces the exact W1258 failure shape.
const reversedScratch = (): string => {
	const repo = mkdtempSync(join(tmpdir(), "w1262-proof-"));
	roots.push(repo);
	git(["init", "-q", "--initial-branch=main"], repo);
	git(["config", "user.email", "t@t"], repo);
	git(["config", "user.name", "t"], repo);
	writeFileSync(join(repo, "README"), "x");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "main"], repo);
	git(["checkout", "-qb", "b"], repo);
	W(join(repo, "pkg/mod.ts"), "export const mod = (): number => 42;\n");
	W(
		join(repo, "pkg/mod.test.ts"),
		[
			'import { mod } from "./mod.ts";',
			'import { test, expect } from "bun:test";',
			'test("mod", () => { expect(mod()).toBe(42); });',
			"",
		].join("\n"),
	);
	git(["add", "-A"], repo);
	git(["commit", "-qm", "b"], repo);
	const patch = git(["diff", "main...b"], repo);
	writeFileSync(join(repo, "p.patch"), patch);
	git(["apply", "-R", "p.patch"], repo);
	git(["checkout", "--", "pkg/mod.test.ts"], repo);
	return repo;
};

// the real production shape (W1258): a new test under packages/suspenders/test
// importing a new module under packages/suspenders/hooks via a relative spec
const W1258 = {
	spec: "../hooks/coord/fleet-table.ts",
	importerSuffix: "packages/suspenders/test/coord-fleet-table.test.ts",
	added: ["packages/suspenders/hooks/coord/fleet-table.ts"],
	tests: ["packages/suspenders/test/coord-fleet-table.test.ts"],
};

afterAll(() => {
	// bun rmSync(force) can silently leave the fixture's .git — bounded 2nd pass
	for (const r of roots) {
		rmSync(r, { recursive: true, force: true });
		rmSync(r, { recursive: true, force: true });
	}
});

test("TEST_FILE still separates test paths from production modules", () => {
	expect(TEST_FILE.test("packages/suspenders/test/x.test.ts")).toBe(true);
	expect(TEST_FILE.test("packages/suspenders/hooks/coord/fleet-table.ts")).toBe(
		false,
	);
});

test("missingImports parses bun's error line (spec + importer)", () => {
	const hits = missingImports(
		"error: Cannot find module './nope-lib' from '/abs/dir/t.test.ts'",
	);
	expect(hits).toHaveLength(1);
	expect(hits[0]?.spec).toBe("./nope-lib");
	expect(hits[0]?.importer).toBe("/abs/dir/t.test.ts");
});

test("diff-added module import failure is explained (W1258 shape, .ts spec)", () => {
	const line = `error: Cannot find module '${W1258.spec}' from '/var/folders/xx/review-proof-abc/${W1258.importerSuffix}'`;
	expect(missingImportsExplained(line, W1258.added, W1258.tests)).toBe(true);
});

test("extensionless spec resolves via the .ts variant", () => {
	const line = `error: Cannot find module '../hooks/coord/fleet-table' from '/tmp/review-proof-abc/${W1258.importerSuffix}'`;
	expect(missingImportsExplained(line, W1258.added, W1258.tests)).toBe(true);
});

test("absolute-spec dynamic import of a diff-added module is explained", () => {
	const line = `error: Cannot find module '/private/var/folders/xx/review-proof-abc/packages/suspenders/hooks/coord/fleet-table.ts' from '/private/var/folders/xx/review-proof-abc/${W1258.importerSuffix}'`;
	expect(missingImportsExplained(line, W1258.added, W1258.tests)).toBe(true);
});

test("missing dependency stays environmental", () => {
	const line = `error: Cannot find package 'left-pad' from '/tmp/review-proof-abc/${W1258.importerSuffix}'`;
	expect(missingImportsExplained(line, W1258.added, W1258.tests)).toBe(false);
});

test("empty added set keeps the old blanket-error behavior", () => {
	const line = `error: Cannot find module '../hooks/coord/fleet-table.ts' from '/tmp/r/${W1258.importerSuffix}'`;
	expect(missingImportsExplained(line, [], W1258.tests)).toBe(false);
});

test("scratch without the change: real bun test failure classifies explained (W1258 regression)", async () => {
	const repo = reversedScratch();
	const p = Bun.spawn([process.execPath, "test", "pkg/mod.test.ts"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		cwd: repo,
		env: process.env,
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	await p.exited;
	const output = `${out}\n${err}`;
	// sanity: the scratch tree really does fail on the missing added module
	expect(output).toContain("Cannot find module");
	// the W1258 shape: the only added production module is the missing one
	expect(
		missingImportsExplained(output, ["pkg/mod.ts"], ["pkg/mod.test.ts"]),
	).toBe(true);
	// negative control: same output against an unrelated added set → error
	expect(
		missingImportsExplained(output, ["pkg/other.ts"], ["pkg/mod.test.ts"]),
	).toBe(false);
	// a missing dependency alongside is never explained
	const withDep = `${output}error: Cannot find package 'left-pad' from '${repo}/pkg/mod.test.ts'\n`;
	expect(
		missingImportsExplained(withDep, ["pkg/mod.ts"], ["pkg/mod.test.ts"]),
	).toBe(false);
});
