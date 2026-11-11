import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	workers: 1,
	timeout: 120000,
	projects: [
		{ name: "unit", testMatch: "*@unit.e2e.ts" },
		{ name: "container", testMatch: "*@container.e2e.ts" },
	],
});
