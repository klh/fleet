// W1294.1 test-framework ratchet, landed early by the W1294.16.1 repair:
// one test framework — every test is a tagged *.e2e.ts @playwright/test
// spec; a new *.test.ts is a ratchet failure. This CENTRAL guard fails
// when the tracked non-decant *.test.ts count rises above the pinned
// ceiling; every migration wave re-pins the ceiling DOWN in the same
// landing. Vendored decant is exempt (not ours to migrate).
// W1294.16 sweep-G re-pin (2026-10-25): 817 -> 792 — 25 buckle/test
// route/admission family files ported to sibling *.e2e.ts specs.
import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DECANT = "packages/decant/";
// The guard is itself a *.test.ts — self-exempt by exact path (the
// law-guards UI_LAW_ALLOWLIST pattern) so the pin counts only the
// migratable corpus.
const SELF = "tests/test-framework-guard.test.ts";
// Shrink-only ceiling: a wave that lowers the count re-pins DOWN here in
// the same landing — never raise the number; port the files instead.
// W2178 landing baseline: main had grown to 873 between the branch cut (792)
// and integration — pinned at the landing count (debt: port the delta);
// W1294.17.1.2 sweep-H slice-B re-pins DOWN (873 → 858); W1294.7 sweep-E
// (56 belt/test files ported at W2178 integration) re-pins DOWN (858 → 802);
// W1294.5 sweep (24 co-situated suspenders specs) re-pins DOWN (802 → 778).
const PIN = 778;

function trackedTestFiles(): string[] {
	const out = Bun.spawnSync(["git", "ls-files", "*.test.ts"], { cwd: ROOT });
	if (out.exitCode !== 0) {
		throw new Error(`git ls-files *.test.ts failed: ${out.stderr}`);
	}
	return new TextDecoder()
		.decode(out.stdout)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

// Pure counter over a path list — the teeth tests below prove it without
// mutating the repo (the detector/fixture split of the import-law guard).
const counted = (paths: readonly string[]): number =>
	paths.filter(
		(p) => p.endsWith(".test.ts") && !p.startsWith(DECANT) && p !== SELF,
	).length;

const violations = (paths: readonly string[], pin: number): string[] => {
	const n = counted(paths);
	return n > pin
		? [
				`${n} tracked *.test.ts > pin ${pin} — port the new files to tagged *.e2e.ts specs (one framework), or re-pin deliberately`,
			]
		: [];
};

test("test-framework ratchet — tracked *.test.ts count within the pinned ceiling (decant exempt)", () => {
	expect(
		violations(trackedTestFiles(), PIN),
		"*.test.ts count rose above the pinned ceiling — port to *.e2e.ts specs and re-pin DOWN in the same landing",
	).toEqual([]);
});

test("ratchet has teeth — a count above the pin reports the overflow", () => {
	const synthetic = Array.from(
		{ length: PIN + 1 },
		(_, i) => `pkg/test/case-${i}.test.ts`,
	);
	const v = violations(synthetic, PIN);
	expect(v).toHaveLength(1);
	expect(v[0]).toContain(`${PIN + 1}`);
});

test("decant stays exempt — vendored *.test.ts never counts toward the ratchet", () => {
	const synthetic = [
		...Array.from({ length: PIN }, (_, i) => `pkg/test/case-${i}.test.ts`),
		"packages/decant/test/vendored.test.ts",
	];
	expect(counted(synthetic)).toBe(PIN);
	expect(violations(synthetic, PIN)).toEqual([]);
});
