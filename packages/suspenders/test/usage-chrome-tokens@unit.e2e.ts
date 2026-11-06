// test/usage-chrome-tokens@unit.e2e.ts — W2784.6.1.3 (W2269.1.4 scope 2):
// the shared usage chrome (local /usage + hub federation page) rides the
// kernel theme scale tokens — no inline style attributes, no literal px
// where a --klh-text/space/radius token carries the same value.

import { SCALE } from "@klh/kernel/src/kernel.theme.module.ts";
import { expect, test } from "@playwright/test";
import { U_CSS, usagePageShell } from "../hooks/bin/usage-chrome.ts";

const page = usagePageShell({ title: "T", body: "<p>b</p>", payload: "{}" });
const tokenized = (family: string): string[] =>
	Object.entries(SCALE)
		.filter(([k]) => k.startsWith(`--klh-${family}`))
		.map(([, v]) => v);

test("usage chrome: no inline style attributes on the shell", () => {
	expect(page).not.toContain(" style=");
	expect(page).toContain('<main class="umain">');
});

test("usage chrome: tokenized sizes never appear as literal px", () => {
	const decls = `${U_CSS}${page.match(/body\{[^}]*\}|\.utitle\{[^}]*\}/g)?.join("") ?? ""}`;
	// each property family checks against its own scale (the ramps overlap)
	const families: [RegExp, string][] = [
		[/(?:font-size|font):[^;}]*/g, "text"],
		[/(?:gap|margin|padding):[^;}]*/g, "space"],
		[/border-radius:[^;}]*/g, "radius"],
	];
	const hits = families.flatMap(([re, fam]) => {
		const scale = tokenized(fam);
		return (decls.match(re) ?? [])
			.flatMap((d) => d.match(/\b\d+(?:\.\d+)?px\b/g) ?? [])
			.filter((px) => scale.includes(px))
			.map((px) => `${fam}:${px}`);
	});
	expect(hits).toEqual([]);
	expect(U_CSS).toContain("var(--klh-text-sm)");
	expect(page).toContain("var(--klh-space-6)");
});
