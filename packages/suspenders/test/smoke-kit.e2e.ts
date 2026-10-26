// smoke-kit.e2e.ts — W1294.1: suspenders' @smoke seed. Proves the package
// config rides the kit and a core face (the verb-kit CLI toolkit law,
// W651) imports pure under the playwright runner. One file, fast, part of
// the smoke dependency chain.
import { expect, test } from "@playwright/test";

test.describe("@smoke suspenders testing-kit resolves", () => {
	test("defineFleetConfig builder imports and declares the five projects", async () => {
		const kit = await import("./helpers/testing-kit.ts");
		const config = kit.defineFleetConfig();
		expect(config.projects?.map((p) => p.name)).toEqual([
			"setup",
			"smoke",
			"unit",
			"api",
			"chromium",
		]);
	});

	test("verb-kit CLI toolkit face imports pure", async () => {
		const { defineVerb, parseVerb } = await import("../hooks/lib/verb-kit");
		const spec = defineVerb({ name: "smoke", usage: "smoke <id>" });
		const out = parseVerb(spec, ["W1"]);
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.parsed.pos).toEqual(["W1"]);
	});
});
