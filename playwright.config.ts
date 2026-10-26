// playwright.config.ts — W1294.1: the repo-root config. The defineFleetConfig
// builder (packages/suspenders/test/helpers/testing-kit.ts) is the ONE source
// of projects/tags/smoke-chain shape; this file binds the standard corpus
// (tests/, the tagged *.e2e.ts files) plus the laws project for the root
// laws specs. Package configs live in packages/*/test/ and import the same
// builder through @klh/suspenders.
import { defineFleetConfig } from "./packages/suspenders/test/helpers/testing-kit.ts";

export default defineFleetConfig({
	testDir: import.meta.dir,
	// tests/*.e2e.ts corpus + the co-situated tagged specs in packages/.
	testMatch: [
		"tests/**/*.e2e.ts",
		"packages/*/test/*.e2e.ts",
		"packages/*/test/**/*.e2e.ts",
	],
	extraProjects: [
		{
			name: "laws",
			testMatch: "tests/laws-mirror.e2e.ts",
		},
	],
});
