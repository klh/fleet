import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	coverageProofManifest,
	pureTestDiff,
	reviewedDiff,
	TEST_FILE,
} from "../hooks/lib/gates/coverage-proof.ts";

const archiveTest =
	"packages/suspenders/hooks/lib/runners/desktop/workspace-archive@unit.e2e.ts";

test("recognizes the exact archive regression and canonical tagged e2e files", () => {
	for (const path of [
		archiveTest,
		"packages/example/src/proof@container.e2e.ts",
		"packages/example/src/proof.e2e.ts",
		"packages/example/src/proof.e2e.tsx",
		"packages/example/src/proof.e2e.mjs",
	])
		expect(TEST_FILE.test(path), path).toBe(true);
	expect(pureTestDiff([archiveTest])).toBe(true);
});

test("does not classify neighboring source or suffix lookalikes as e2e tests", () => {
	for (const path of [
		"packages/suspenders/hooks/lib/runners/desktop/workspace-archive.ts",
		"packages/suspenders/hooks/lib/runners/desktop/wiring.ts",
		"packages/example/src/proof.e2e.ts.backup",
		"packages/example/src/e2e.ts",
		"packages/example/src/proof.e2e.json",
	])
		expect(TEST_FILE.test(path), path).toBe(false);
	expect(pureTestDiff([archiveTest, "src/implementation.ts"])).toBe(false);
});

test("rejects mutable, missing and non-commit proof inputs", () => {
	const f = fixture();
	try {
		expect(() => coverageProofManifest("main", f.head, f.git)).toThrow(
			"immutable",
		);
		expect(() => coverageProofManifest(f.base, "0".repeat(40), f.git)).toThrow(
			"failed",
		);
		const blob = f.checked("rev-parse", `${f.head}:source.ts`);
		expect(() => coverageProofManifest(f.base, blob, f.git)).toThrow(
			"not a commit",
		);
		expect(() =>
			coverageProofManifest(f.base, f.head, () => ({ code: 1, out: "" })),
		).toThrow("failed");
	} finally {
		rmSync(f.repo, { recursive: true, force: true });
	}
});

test("separates unsupported Playwright files from runnable Bun tests and no tests", () => {
	const f = fixture();
	try {
		const empty = coverageProofManifest(f.head, f.head, f.git);
		expect(empty.testFiles).toEqual([]);
		expect(empty.skip).toBe("no test files in diff");
		const mixed = f.commit(
			{ "legacy.spec.ts": "bun test", "added.ts": "module" },
			"mixed",
		);
		const manifest = coverageProofManifest(f.base, mixed, f.git);
		expect(manifest.provable).toEqual(["legacy.spec.ts"]);
		expect(manifest.testFiles).toEqual(["legacy.spec.ts", "new@unit.e2e.ts"]);
		expect(manifest.addedProd).toEqual(["added.ts"]);
		expect(manifest.skip).toBeNull();
	} finally {
		rmSync(f.repo, { recursive: true, force: true });
	}
});

function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "coverage-inputs-"));
	const git = (args: string[]) => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5000,
		});
		return { code: p.exitCode, out: p.stdout.toString() };
	};
	const checked = (...args: string[]) => {
		const r = git(args);
		expect(r.code, args.join(" ")).toBe(0);
		return r.out.trim();
	};
	checked("init", "-q", "--initial-branch=main");
	checked("config", "user.email", "fixture@example.invalid");
	checked("config", "user.name", "coverage fixture");
	const commit = (files: Record<string, string>, message: string) => {
		for (const [path, text] of Object.entries(files))
			writeFileSync(join(repo, path), text);
		checked("add", "-A");
		checked("-c", "core.hooksPath=/dev/null", "commit", "-qm", message);
		return checked("rev-parse", "HEAD");
	};
	const base = commit({ "source.ts": "baseline", "old.e2e.ts": "old" }, "base");
	checked("checkout", "-qb", "candidate");
	checked("rm", "old.e2e.ts");
	const head = commit(
		{ "source.ts": "candidate", "new@unit.e2e.ts": "test" },
		"head",
	);
	return { repo, git, checked, commit, base, head };
}

test("proof manifest stays bound to reviewed commits when main and branch move", () => {
	const f = fixture();
	try {
		const manifest = coverageProofManifest;
		const before = manifest(f.base, f.head, f.git);
		expect(before.testFiles).toEqual(["new@unit.e2e.ts"]);
		expect(before.provable).toEqual([]);
		expect(before.skip).toContain("unsupported");
		f.checked("checkout", "main");
		const moved = f.commit({ "new@unit.e2e.ts": "main advanced" }, "move main");
		f.checked("branch", "-f", "candidate", moved);
		f.checked("replace", f.head, moved);
		expect(manifest(f.base, f.head, f.git)).toEqual(before);
		expect(before.changed).toEqual([
			"new@unit.e2e.ts",
			"old.e2e.ts",
			"source.ts",
		]);
		expect(before.mergeBase).toBe(f.base);
	} finally {
		rmSync(f.repo, { recursive: true, force: true });
	}
});

test("model-facing reviewed text ignores replacement commits just like the proof", () => {
	const f = fixture();
	try {
		const original = reviewedDiff(f.base, f.head, f.git);
		expect(original).toContain("+candidate");
		const replacement = f.checked(
			"commit-tree",
			`${f.base}^{tree}`,
			"-p",
			f.base,
			"-m",
			"replacement with baseline tree",
		);
		f.checked("replace", f.head, replacement);
		expect(f.checked("diff", `${f.base}...${f.head}`)).toBe("");
		expect(reviewedDiff(f.base, f.head, f.git)).toBe(original);
		expect(coverageProofManifest(f.base, f.head, f.git).testFiles).toEqual([
			"new@unit.e2e.ts",
		]);
	} finally {
		rmSync(f.repo, { recursive: true, force: true });
	}
});
