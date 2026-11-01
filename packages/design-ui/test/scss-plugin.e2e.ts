// scss-plugin.e2e.ts — W2269.1.1: the SCSS → Lit static-styles plugin.
// Sass computes at build time; custom properties carry the theme through
// shadow DOM at runtime.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	compileStylesheet,
	emitStylesModule,
} from "../src/build/scss-plugin.ts";

test.describe("scss → lit styles plugin (W2269.1.1)", () => {
	const dir = mkdtempSync(join(tmpdir(), "dui-scss-"));
	const scss = join(dir, "widget.scss");
	const out = join(dir, "widget.styles.ts");

	test("compiles scss to css text @unit", () => {
		writeFileSync(
			scss,
			[
				".widget {",
				"  padding: var(--klh-space-4);",
				"  color: var(--klh-c-ink);",
				"  &.active { border: 1px solid var(--klh-c-accent); }",
				"}",
			].join("\n"),
		);
		const css = compileStylesheet(scss);
		expect(css).toContain(".widget");
		expect(css).toContain("var(--klh-c-ink)");
		expect(css).toContain(".widget.active");
	});

	test("emits a lit static-styles module @unit", () => {
		emitStylesModule(scss, out);
		const mod = readFileSync(out, "utf8");
		expect(mod).toContain('import { css, unsafeCSS } from "lit"');
		expect(mod).toContain("export const styles = css`");
		rmSync(dir, { recursive: true, force: true });
	});
});
