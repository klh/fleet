// test/federation-work-tokens@unit.e2e.ts — W2784.6.1.4 (W2269.1.4 scope 3):
// the federated work page rides the kernel theme — THEME_HEAD + fleet nav,
// every colour a --klh-* token, no literal hex palette, no inline styles.

import { expect, test } from "@playwright/test";
import {
	federationWorkPage,
	pageCss,
} from "../hooks/bin/federation-work-html.ts";

const view = {
	me: "lab",
	generated_at: "2026-11-06T00:00:00Z",
	local: {
		hub: "lab",
		total: 1,
		trunc: false,
		generated_at: "2026-11-06T00:00:00Z",
		items: [{ id: "W1", state: "READY", title: "t" }],
	},
	peers: [],
} as unknown as Parameters<typeof federationWorkPage>[0];
const html = federationWorkPage(view);

test("federation work: page carries the theme head and fleet nav", () => {
	expect(html).toContain("--klh-bg");
	expect(html).toContain('<main class="fwork">');
	expect(html).toContain("Workflows");
	expect(html).not.toContain(" style=");
});

test("federation work: css has no literal colours or rem sizing", () => {
	const css = pageCss();
	expect(css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).toEqual([]);
	expect(css.match(/\d+(?:\.\d+)?rem\b/g) ?? []).toEqual(["60rem"]);
	expect(css).toContain("var(--klh-danger-ink)");
});
