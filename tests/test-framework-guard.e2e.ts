// tests/test-framework-guard.e2e.ts — W1294.1: the shrink-only ratchet on the
// bun:test → playwright corpus. The repo's tracked non-decant *.test.ts count
// may never RISE above the pinned baseline; every migration wave that removes
// bun:test files re-pins DOWN in the same landing. Vendored decant is exempt.
// Baseline is re-measured at this file's landing commit (811 on
// suspenders/W1294.1); integration re-pins it to the merged tree's count
// (main integrated 804 via the wave lanes).
import { expect, test } from "@playwright/test";

const BASELINE = 811;

test.describe("@unit test-framework ratchet", () => {
	test("non-decant *.test.ts count does not exceed the pinned baseline", async () => {
		const proc = Bun.spawnSync(["git", "ls-files", "*.test.ts"], {
			cwd: import.meta.dir,
		});
		if (proc.exitCode !== 0) {
			throw new Error(`git ls-files failed: ${proc.stderr.toString()}`);
		}
		const files = proc.stdout
			.toString()
			.split("\n")
			.filter((f) => f.length > 0 && !f.startsWith("packages/decant/"));
		expect(
			files.length,
			`tracked non-decant *.test.ts count ${files.length} exceeds the ratchet baseline ${BASELINE}. Migration waves must REMOVE bun:test files, never add: re-pin BASELINE down to the new count in the same landing.`,
		).toBeLessThanOrEqual(BASELINE);
	});
});
