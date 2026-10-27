// W1302.7 — test-import resolution canary, the CI face (O4,
// docs/workflow-adjustments-2026-10-25.md). The W1283 reorg left suites
// dead at load (route-preflight.test.ts imports `routeInputsByMachine`,
// which current main does not export: 0 pass / 1 fail / 1 error). This
// guard scans every tracked test file: a RELATIVE import must resolve to
// an existing file and every VALUE binding must still exist in the
// target's (transitive) export surface — reorg-removed paths and exports
// flip a red guard instead of silently dead suites.
//
// Scanner: packages/suspenders/hooks/lib/gates/test-import-resolution.ts
// (W1302.7.1 — a NON-test path, deliberately: the Sinai coverage proof
// reverses the branch diff and restores only test files, so a scanner
// living under tests/ would be restored with its guard and the proof goes
// vacuously green. At a production path the reversal deletes the scanner
// while the restored guard dies on the missing module — the W1262-blessed
// proof shape). Type-only imports are existence-checked only (Bun erases
// them — they cannot kill a suite; the four known type-drift rows went to
// the lane report as leads). The dead-import pin list below is exact both
// directions (SH_ALLOWLIST idiom): a pin that stops matching refuses
// closure until dropped, so the list cannot rot.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkTestImports,
	collectTestFiles,
	renderViolation,
} from "../packages/suspenders/hooks/lib/gates/test-import-resolution.ts";

const ROOT = join(import.meta.dir, "..");

// No pins: W1294.13 repaired the route-preflight instance (the original
// pin is dropped with it). A new dead import lands as a red row — repair
// it or pin it here with the owning item.
const KNOWN_DEAD: string[] = [];

// The synthetic tree the teeth build: every accepted import form plus one
// dead variant per detector.
const FIXTURE_FILES: Record<string, string> = {
	"lib/util.ts": `export const real = 1;
export default function base() {}
export { real as assertNoSecrets };
`,
	"lib/named.ts": `export { real as renamed } from "./util.ts";
`,
	"lib/rexport.ts": `export * from "./util.ts";
`,
	"lib/side.ts": "export const marker = true;\n",
	"lib/empty.ts": "",
	"a/ok.test.ts": `import base from "../lib/util.ts";
import { real } from "../lib/util.ts";
import { renamed } from "../lib/named.ts";
import { real as starReal } from "../lib/rexport.ts";
import { assertNoSecrets } from "../lib/util.ts";
import * as util from "../lib/util.ts";
import "../lib/side.ts";
await import("../lib/util.ts?bust=1");
`,
	"a/dead.test.ts": `import { ghost } from "../lib/util.ts";
import nothere from "../lib/named.ts";
import { x } from "../lib/void.ts";
import * as nothing from "../lib/empty.ts";
await import("../lib/void.ts");
`,
};

let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "w1302-7-teeth-"));
	for (const [rel, body] of Object.entries(FIXTURE_FILES)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), body);
	}
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("the ok fixture is fully clean (no false positives on accepted forms)", () => {
	const res = checkTestImports(dir, ["a/ok.test.ts"]);
	expect(res.edges).toBe(8);
	expect(res.violations.map(renderViolation)).toEqual([]);
});

test("the dead fixture trips every detector", () => {
	const res = checkTestImports(dir, ["a/dead.test.ts"]);
	const got = res.violations.map(renderViolation).sort();
	expect(got).toEqual(
		[
			"a/dead.test.ts -> ../lib/void.ts (missing-target)",
			"a/dead.test.ts -> ../lib/void.ts (missing-target)",
			"a/dead.test.ts -> ../lib/util.ts (ghost)",
			"a/dead.test.ts -> ../lib/named.ts (nothere)",
			"a/dead.test.ts -> ../lib/empty.ts (nothing)",
		].sort(),
	);
});

test("missing-export skips a default that does exist", () => {
	const res = checkTestImports(dir, ["a/ok.test.ts"]);
	expect(res.violations.some((v) => v.name === "default")).toBe(false);
});

test("every tracked test relative import resolves and exports its names", () => {
	const res = checkTestImports(ROOT, collectTestFiles(ROOT));
	const pinned = res.violations.map(renderViolation);
	const live = pinned.filter((p) => !KNOWN_DEAD.includes(p));
	const dead = KNOWN_DEAD.filter((k) => !pinned.includes(k));
	expect(
		dead,
		"KNOWN_DEAD pins no longer match — the repair landed, drop the pin",
	).toEqual([]);
	expect(
		live,
		"dead relative imports in tracked test files — repair the import or pin it here with the owning item",
	).toEqual([]);
});

test("the scan has teeth (real tracked test population)", () => {
	expect(collectTestFiles(ROOT).length).toBeGreaterThan(500);
});
