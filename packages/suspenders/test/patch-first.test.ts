// test/patch-first.test.ts — W744: the patch-first contract. Covered: line
// counting + blob-at-sha reads, per-file churn (baseline numstat + single-
// commit diff-tree), the decomposition exemption, the done-gate verdict
// (rewrite refuses, patch passes, fail-open on missing evidence), and the
// brief directive rendering.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	briefPatchFirstLines,
	diffChurn,
	isDecompositionItem,
	lineCountAt,
	PATCH_FIRST_CHURN_BUDGET,
	PATCH_FIRST_THRESHOLD,
	patchFirstVerdict,
} from "../hooks/lib/patch-first.ts";
import { renderIntel } from "../hooks/lib/brief-intel.ts";

// scratch repo with one near-cap-ish file (threshold overridden per verdict,
// so a 12-line file stands in for 1200)
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w744-pf-repo-"));
const g = (args: string[]): void => {
	const p = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
const write = (name: string, lines: number): void => {
	writeFileSync(
		join(REPO, name),
		Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join("\n") +
			"\n",
	);
};
mkdirSync(join(REPO, "src"), { recursive: true });
write("src/big.ts", 12);
write("src/small.ts", 4);
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
g(["add", "-A"]);
g(["commit", "-m", "base"]);
const BASE = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: REPO,
	encoding: "utf8",
}).stdout.trim();

describe("line counting + blob reads", () => {
	test("lineCountAt reads the blob at a sha", () => {
		expect(lineCountAt(REPO, BASE, "src/big.ts")).toBe(12);
		expect(lineCountAt(REPO, BASE, "src/small.ts")).toBe(4);
		expect(lineCountAt(REPO, BASE, "src/absent.ts")).toBeNull();
	});

	test("diffChurn: baseline numstat and single-commit diff-tree agree", () => {
		write("src/big.ts", 14); // +2
		g(["add", "-A"]);
		g(["commit", "-m", "grow"]);
		const sha = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: REPO,
			encoding: "utf8",
		}).stdout.trim();
		const viaBase = diffChurn(REPO, BASE, sha, "src/big.ts");
		expect(viaBase).toEqual({ added: 2, removed: 0 });
		const viaTree = diffChurn(REPO, null, sha, "src/big.ts");
		expect(viaTree).toEqual({ added: 2, removed: 0 });
		expect(diffChurn(REPO, BASE, sha, "src/absent.ts")).toBeNull();
	});
});

describe("verdict", () => {
	test("decomposition items are exempt by title or description", () => {
		expect(isDecompositionItem("decompose fleet-loop.ts")).toBe(true);
		expect(isDecompositionItem("DRY and decompose lib/x.ts")).toBe(true);
		expect(
			isDecompositionItem("t", "split by responsibility — a decomposition"),
		).toBe(true);
		expect(isDecompositionItem("patch a bug", "nope")).toBe(false);
	});

	test("rewrite of a near-cap file refuses; patch passes", () => {
		// rewrite: 12-line file replaced wholesale in the closing commit
		write("src/big.ts", 5);
		g(["add", "-A"]);
		g(["commit", "-m", "rewrite"]);
		const rewrite = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: REPO,
			encoding: "utf8",
		}).stdout.trim();
		const v = patchFirstVerdict({
			repo: REPO,
			paths: ["src/big.ts"],
			baseline: BASE,
			sha: rewrite,
			title: "polish big.ts",
			threshold: 3,
			budget: 4,
			disabled: false,
		});
		expect(v.ok).toBe(false);
		expect(v.why).toContain("patch-first (W744)");

		// patch: an anchored change from the rewrite's own baseline stays in
		// budget (the rewrite above is its own closed chapter)
		write("src/big.ts", 6);
		g(["add", "-A"]);
		g(["commit", "-m", "patch"]);
		const patched = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: REPO,
			encoding: "utf8",
		}).stdout.trim();
		const ok = patchFirstVerdict({
			repo: REPO,
			paths: ["src/big.ts"],
			baseline: rewrite,
			sha: patched,
			title: "polish big.ts",
			threshold: 3,
			budget: 4,
			disabled: false,
		});
		expect(ok.ok).toBe(true);
	});

	test("under threshold / disabled / fail-open all pass", () => {
		expect(
			patchFirstVerdict({
				repo: REPO,
				paths: ["src/small.ts"],
				baseline: BASE,
				sha: BASE,
				threshold: 10,
				budget: 1,
				disabled: false,
			}).ok,
		).toBe(true);
		expect(
			patchFirstVerdict({
				repo: REPO,
				paths: ["src/big.ts"],
				baseline: BASE,
				sha: BASE,
				threshold: 3,
				budget: 1,
				disabled: true,
			}).ok,
		).toBe(true);
		// unreadable blob at sha → fail open
		expect(
			patchFirstVerdict({
				repo: REPO,
				paths: ["src/big.ts"],
				baseline: BASE,
				sha: "not-a-sha",
				threshold: 3,
				budget: 1,
				disabled: false,
			}).ok,
		).toBe(true);
	});

	test("constants hold the survey calibration", () => {
		expect(PATCH_FIRST_THRESHOLD).toBe(1200);
		expect(PATCH_FIRST_CHURN_BUDGET).toBe(300);
	});
});

describe("brief directive", () => {
	test("renders the patch-only directive for near-cap files", () => {
		const lines = briefPatchFirstLines(
			[
				{ path: "src/big.ts", lines: 1493 },
				{ path: "src/small.ts", lines: 42 },
			],
			1200,
		);
		expect(lines.join("\n")).toContain("PATCH-FIRST (W744)");
		expect(lines.join("\n")).toContain("src/big.ts is 1493 lines");
		expect(lines.join("\n")).not.toContain("src/small.ts");

		expect(briefPatchFirstLines([{ path: "a.ts", lines: 10 }])).toEqual([]);
		expect(briefPatchFirstLines([{ path: "a.ts", lines: null }])).toEqual([]);
	});

	test("renderIntel surfaces a patchFirst-only intel", () => {
		const out = renderIntel({
			fileMap: [],
			doneDigest: [],
			patchFirst: ["PATCH-FIRST (W744): x"],
		});
		expect(out).toContain("PATCH-FIRST (W744): x");
	});
});

afterAll(() => rmSync(REPO, { recursive: true, force: true }));
