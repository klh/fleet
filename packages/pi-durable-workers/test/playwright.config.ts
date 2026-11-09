import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*@unit.e2e.ts",
	workers: 1,
	projects: [{ name: "unit" }],
});
