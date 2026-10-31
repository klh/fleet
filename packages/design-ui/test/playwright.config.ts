// test/playwright.config.ts — W2269.1.1: design-ui's package config. Every
// default rides the central playwright.base.ts (decision.central-configs);
// the deltas here scope the corpus AND add the W2269.1.5 visual + a11y
// projects (smoke → chromium → visual/a11y order rides CI project filters).
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig({
	projects: [
		{ name: "unit", testMatch: /events-kit|scss-plugin|tokens-build/ },
		{
			name: "visual",
			testMatch: /catalog\.visual\.e2e\.ts/,
		},
		{
			name: "a11y",
			testMatch: /catalog\.a11y\.e2e\.ts/,
		},
	],
});
