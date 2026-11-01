// tokens-build.e2e.ts — W2269.1.1: the token build face. The build runs the
// WCAG AA contrast check over every text/surface pair in every theme and
// emits dist/tokens.css (+ typed module + per-theme files); a failing pair
// exits 1. Asserts the emitted face: board page tokens keep their W2267.1
// names, semantic roles land in the --klh-c-* namespace.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const PKG = join(import.meta.dir, "..");
const BUILD = join(PKG, "src", "tokens", "build.ts");
const DIST = join(PKG, "src", "tokens", "dist");

test.describe("token build face (W2269.1.1)", () => {
	test("build runs clean and emits the token face @unit", () => {
		const run = spawnSync(process.execPath, [BUILD], { encoding: "utf8" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("AA check clean");
		expect(run.stdout).toContain("2 theme files");
		const css = readFileSync(join(DIST, "tokens.css"), "utf8");
		expect(css).toContain(":root {");
		for (const row of [
			"--klh-c-surface:",
			"--klh-c-ink:",
			"--klh-c-accent:",
			"--klh-c-status-ok:",
			"--klh-c-status-err:",
			"--klh-c-focus:",
			"--board-pad-x: 24px;",
			"--board-mast-rule-w: 3px;",
			"--board-label-track: 0.09em;",
			"--board-label-size: 10px;",
			`[data-theme="light"] {`,
			`[data-theme="high-contrast"] {`,
		])
			expect(css).toContain(row);
		for (const theme of ["light", "high-contrast"])
			expect(
				readFileSync(join(DIST, "themes", `${theme}.css`), "utf8"),
			).toContain(`[data-theme="${theme}"]`);
	});

	test("typed module: TOKENS keys carry the semantic names @unit", () => {
		const src = readFileSync(join(DIST, "tokens.ts"), "utf8");
		expect(src).toContain('"--klh-c-surface"');
		expect(src).toContain("as const");
		expect(src).toContain("export type TokenName");
	});
});
