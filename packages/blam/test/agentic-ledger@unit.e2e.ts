// test/agentic-ledger@unit.e2e.ts — W2971.1 second held-out fixture guards:
// prepare refuses an existing target, and the documented oracle controls
// reproduce on a clean checkout (broken 9/24, reference 24/24). Bun-only,
// no Docker; the oracle is imported as the private judge it is.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { prepareFixture } from "../bench/agentic-ledger/prepare-lib.ts";
import { runOracle } from "../bench/agentic-ledger/oracle-lib.ts";

const BENCH = join(import.meta.dir, "..", "bench", "agentic-ledger");

test("prepare refuses an existing target", () => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-fix-"));
	try {
		expect(() => prepareFixture(dir)).toThrow(
			/refusing existing fixture directory/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("documented controls reproduce on a clean checkout: broken 9/24, reference 24/24", async () => {
	const root = mkdtempSync(join(tmpdir(), "ledger-ctl-"));
	try {
		// two independent worktrees — Bun caches modules by path, so the
		// reference phase gets its own sealed copy rather than an overwrite
		const brokenTree = prepareFixture(join(root, "broken"));
		const referenceTree = prepareFixture(join(root, "reference"));
		expect(existsSync(join(brokenTree, ".git"))).toBe(true);
		cpSync(join(BENCH, "reference"), join(referenceTree, "src"), {
			recursive: true,
		});
		const broken = await runOracle(BENCH, brokenTree);
		expect(broken.total).toBe(24);
		expect(broken.passed).toBe(9);
		expect(broken.score).toBeCloseTo(0.375, 5);
		const reference = await runOracle(BENCH, referenceTree);
		expect(reference.passed).toBe(24);
		expect(reference.score).toBe(1);
		expect(reference.failures).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
