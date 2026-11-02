// tokens-build.e2e.ts — W2269.1.1: the token build face. The build runs the
// WCAG AA contrast check over every text/surface pair in every theme and
// emits dist/tokens.css (+ typed module + per-theme files); a failing pair
// exits 1. Asserts the emitted face: board page tokens keep their W2267.1
// names, semantic roles land in the --klh-c-* namespace.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

	// W2549: the flatten collision — space "3"=6px vs radius "3"=8px are
	// equal keys in different groups; last-wins flattening shipped
	// --klh-space-3: 8px and erased the radius scale. Group namespacing
	// makes the overwrite structurally impossible: BOTH rows must exist.
	test("numeric-key collision across groups: space-3 AND radius-3 @unit", () => {
		const css = readFileSync(join(DIST, "tokens.css"), "utf8");
		expect(css).toContain("--klh-space-3: 6px;");
		expect(css).toContain("--klh-radius-3: 8px;");
		expect(css).toContain("--klh-radius-1: 2px;");
		expect(css).toContain("--klh-radius-2: 4px;");
		// the space scale keeps its own ladder (source truth, No09 layout)
		expect(css).toContain("--klh-space-4: 8px;");
		expect(css).not.toContain("--klh-space-3: 8px;");
	});

	// W2549: the namespace leak — primName's key-shape fallthrough named
	// every non-typo non-numeric primitive --klh-radius-*: 25 color rows
	// (--klh-radius-ink-900…) and motion rows (--klh-radius-step: 120ms).
	// Namespaces derives from the GROUP; the radius namespace may hold
	// only the radius group's rows.
	test("no --klh-radius-* row outside the radius group @unit", () => {
		const css = readFileSync(join(DIST, "tokens.css"), "utf8");
		const radiusRows = [...css.matchAll(/--klh-radius-[a-z0-9-]+(?=:)/g)].map(
			(m) => m[0],
		);
		expect(radiusRows).toEqual([
			"--klh-radius-1",
			"--klh-radius-2",
			"--klh-radius-3",
		]);
		expect(css).toContain("--klh-motion-step: 120ms;");
		expect(css).toContain("--klh-color-ink-900:");
		expect(css).not.toMatch(
			/--klh-radius-(ink|paper|accent|ok|warn|err|info|focus|step|pace|drift)/,
		);
	});

	// W2549: every var(--klh-*) a suspenders board file references resolves
	// against a token the fleet actually defines — design-ui dist ∪ the
	// kernel theme module (the board's runtime source). The union mirrors
	// what a page wearing both stylesheets can rely on.
	test("every var(--klh-*) in suspenders board files resolves @unit", () => {
		const defined = new Set<string>();
		for (const m of readFileSync(join(DIST, "tokens.css"), "utf8").matchAll(
			/--klh-[a-z0-9-]+(?=:)/g,
		))
			defined.add(m[0]);
		// kernel defines tokens as quoted TS object keys ("--klh-dim":)
		const kernelSrc = readFileSync(
			join(PKG, "..", "kernel", "src", "kernel.theme.module.ts"),
			"utf8",
		);
		for (const m of kernelSrc.matchAll(/--klh-[a-z0-9-]+"?(?=:)/g))
			defined.add(m[0].replace(/"$/, ""));
		const mono = join(PKG, "..");
		const stray: string[] = [];
		for (const dir of ["hooks/board-html", "hooks/lib/ui", "hooks/bin"]) {
			for (const f of readdirSync(join(mono, "suspenders", dir)).filter((f) =>
				f.endsWith(".ts"),
			)) {
				const src = readFileSync(join(mono, "suspenders", dir, f), "utf8");
				for (const m of src.matchAll(/var\((--klh-[a-z0-9-]+)/g)) {
					const ref = m[1].replace(/,\s*[^)]*\)$/, "");
					if (!defined.has(ref)) stray.push(`${dir}/${f}: ${ref}`);
				}
			}
		}
		expect(stray).toEqual([]);
	});
});
