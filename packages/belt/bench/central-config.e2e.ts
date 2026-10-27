// W1294.18.1: coverage for the central-extends config shape
// (decision.central-configs). The bench config must stay a zero-delta
// extension of playwright.base.ts — a re-declared default here drifts the
// package away from the center and fails the zero-deltas test below.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineFleetConfig } from "../../../playwright.base.ts";
import benchConfig from "./playwright.config.ts";

test.describe("central playwright config shape @unit", () => {
	test("defineFleetConfig owns the fleet defaults @unit", () => {
		const base = defineFleetConfig();
		expect(base.testDir).toBe(".");
		expect(base.testMatch).toBe("**/*.e2e.ts");
		expect(base.timeout).toBe(60_000);
		expect(base.expect).toEqual({ timeout: 5_000 });
		expect(base.workers).toBe(1);
		expect(base.fullyParallel).toBe(false);
		expect(base.retries).toBe(0);
		expect(base.reporter).toEqual([["list"]]);
		expect(base.outputDir).toBe("test-results");
		expect(base.projects).toEqual([{ name: "unit", testMatch: "**/*.e2e.ts" }]);
	});
	test("bench config extends the base with zero deltas @unit", () => {
		// metadata is injected by playwright's own config loader into the
		// imported module — not a declared delta; compare declared keys only.
		const strip = (c: typeof benchConfig) => {
			const copy = { ...c } as Record<string, unknown>;
			delete copy.metadata;
			return copy;
		};
		expect(strip(benchConfig)).toEqual(strip(defineFleetConfig()));
	});
	test("deltas override only the named keys @unit", () => {
		const cfg = defineFleetConfig({ timeout: 120_000 });
		expect(cfg.timeout).toBe(120_000);
		expect(cfg.workers).toBe(1);
		expect(cfg.testMatch).toBe("**/*.e2e.ts");
	});
	test("bench config source imports the central builder, no re-declared defaults @unit", () => {
		// The review defect was source SHAPE: defineConfig + re-declared
		// center-owned defaults. Assert the file imports defineFleetConfig
		// from the central base and declares none of the center-owned keys.
		const src = readFileSync(
			join(
				dirname(import.meta.url.replace("file://", "")),
				"playwright.config.ts",
			),
			"utf8",
		);
		expect(src).toContain('from "../../../playwright.base.ts"');
		expect(src).toContain("defineFleetConfig");
		expect(src).not.toContain("defineConfig");
		for (const key of [
			"testMatch:",
			"timeout:",
			"workers:",
			"fullyParallel:",
			"retries:",
			"reporter:",
			"outputDir:",
			"expect:",
		])
			expect(src).not.toContain(key);
	});
});
