// smoke-kit.e2e.ts — W1294.1: buckle's @smoke seed. Proves the package
// config resolves the defineFleetConfig builder through @klh/suspenders and
// that a core face imports pure (no server spin-up) under the playwright
// runner. One test, fast, part of the smoke dependency chain.
import { expect, test } from "@playwright/test";

test.describe("@smoke buckle testing-kit resolves", () => {
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

	test("core admission face imports pure", async () => {
		const { RpcAdmission, DEFAULT_MAX_INFLIGHT } = await import(
			"../src/admission"
		);
		expect(DEFAULT_MAX_INFLIGHT).toBeGreaterThan(0);
		expect(new RpcAdmission()).toBeDefined();
	});
});
