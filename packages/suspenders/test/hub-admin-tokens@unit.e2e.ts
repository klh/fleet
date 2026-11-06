// test/hub-admin-tokens@unit.e2e.ts — W2784.6.1.5 (W2269.1.4 scope 4): the
// /console/hub page is chrome only (hub-admin-html.ts) and the klh-hub-admin
// Lit surface it hosts rides the kernel theme scale tokens — no literal px
// where a --klh-text/space/radius token carries the same value. The source
// is read as text: the element module needs a DOM (customElements) to load.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SCALE } from "@klh/kernel/src/kernel.theme.module.ts";
import { consolePage } from "../hooks/bin/console-html.ts";
import { hubPage } from "../hooks/bin/hub-admin-html.ts";

const src = readFileSync(
	join(import.meta.dirname, "../hooks/board-html/klh-hub-admin.ts"),
	"utf8",
);
const styles = src.slice(
	src.indexOf("static styles"),
	src.indexOf("];", src.indexOf("static styles")),
);
const tokenized = (family: string): string[] =>
	Object.entries(SCALE)
		.filter(([k]) => k.startsWith(`--klh-${family}`))
		.map(([, v]) => v);

test("hub admin page: chrome only, hosts the Lit surface", () => {
	const page = hubPage();
	expect(page).toContain("<klh-hub-admin></klh-hub-admin>");
	expect(page).toContain('src="/vendor/klh-hub-admin.js"');
	// hub-admin-html adds no inline style of its own (the <main> shell is
	// consolePage's, scope 1)
	expect(page.match(/ style=/g)?.length ?? 0).toBe(
		consolePage("x", "hub", "", undefined).match(/ style=/g)?.length ?? 0,
	);
});

test("klh-hub-admin styles: tokenized sizes never appear as literal px", () => {
	// each property family checks against its own scale (the ramps overlap);
	// px inside a var() fallback (", 14px)") is the token's own default
	const families: [RegExp, string][] = [
		[/(?<![\w-])(?:font-size|font)\s*:[^;}]*/g, "text"],
		[/(?<![\w-])(?:gap|margin|padding)(?:-[a-z]+)?\s*:[^;}]*/g, "space"],
		[/border-radius\s*:[^;}]*/g, "radius"],
	];
	const hits = families.flatMap(([re, fam]) => {
		const scale = tokenized(fam);
		return (styles.match(re) ?? [])
			.flatMap((d) => d.match(/(?<!, )\b\d+(?:\.\d+)?px\b/g) ?? [])
			.filter((px) => scale.includes(px))
			.map((px) => `${fam}:${px}`);
	});
	expect(hits).toEqual([]);
	expect(styles).toContain("var(--klh-text-sm)");
	expect(styles).toContain("var(--klh-space-3)");
	expect(styles).toContain("var(--klh-radius)");
});
