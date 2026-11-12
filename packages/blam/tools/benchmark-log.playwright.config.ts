import { defineFleetConfig } from "../../../playwright.base.ts";
export default defineFleetConfig({
	testDir: ".",
	testMatch: "benchmark-log@unit.e2e.ts",
});
