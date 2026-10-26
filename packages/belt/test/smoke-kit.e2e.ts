// smoke-kit.e2e.ts — W1294.1: belt's @smoke seed. Proves the package config
// resolves the defineFleetConfig builder through @klh/suspenders and that a
// core face imports pure (no specialists spawned) under the playwright
// runner. One test, fast, part of the smoke dependency chain.
import { expect, test } from "@playwright/test";

test.describe("@smoke belt testing-kit resolves", () => {
	test("defineFleetConfig builder imports and declares the five projects", async () => {
		const kit = await import("@klh/suspenders/test/helpers/testing-kit.ts");
		const config = kit.defineFleetConfig();
		expect(config.projects?.map((p) => p.name)).toEqual([
			"setup",
			"smoke",
			"unit",
			"api",
			"chromium",
		]);
	});

	test("specialist registry face imports pure", async () => {
		const registry = await import("../bin/registry");
		expect(registry.SPECIALIST_PROTOCOL).toBe("openai");
		expect(typeof registry.thisPlatform).toBe("function");
	});
});
