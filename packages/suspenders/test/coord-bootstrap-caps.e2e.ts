// coord-bootstrap-caps.e2e.ts — W2456.1: cmdBootstrap's --caps vocabulary is
// the W1211 credential-scope set — validScopeToken (gh, az, cloud-*, tool-*)
// rides the same filter as CAPABILITIES and the die names the extended
// vocabulary. Merge 7f01369e briefly resurrected the pre-W1211
// CAPABILITIES.includes check (coord bootstrap --caps gh died 'unknown
// capability'); this pins both directions. Both probes die at the --tags
// parse — AFTER caps validation, BEFORE any sessions row — so the fixture
// db stays empty.
import { expect, test } from "@playwright/test";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

test.describe("@unit", () => {
	const fx = cliFixture("w2456-bootstrap-caps", {
		env: { GOVERNOR_STORE_URL: "local" },
	});

	test.afterAll(() => fx.cleanup());

	const runCli = (args: string[]): { code: number; out: string; err: string } =>
		fx.run("coord.ts", args);

	test.describe("coord bootstrap --caps vocabulary (W1211)", () => {
		test("credential-scope token gh validates, not just CAPABILITIES", () => {
			// gh passes caps validation → death comes later, from the invalid
			// --tags parse; never 'unknown capability'. Pre-insert: zero rows.
			const r = runCli([
				"bootstrap",
				"--as",
				"w2456-caps-probe",
				"--caps",
				"gh",
				"--tags",
				"not-json",
			]);
			expect(r.err).toContain("--tags must be valid JSON");
			expect(r.err).not.toContain("unknown capability");
			expect(fx.q("SELECT * FROM sessions")).toEqual([]);
		});

		test("bogus token dies with the W1211 extended vocabulary", () => {
			const r = runCli([
				"bootstrap",
				"--as",
				"w2456-caps-probe",
				"--caps",
				"ghost-cap",
				"--tags",
				"not-json",
			]);
			expect(r.err).toContain("unknown capability: ghost-cap");
			expect(r.err).toContain("gh, az, cloud-<provider>, tool-<cli>");
			expect(fx.q("SELECT * FROM sessions")).toEqual([]);
		});
	});
});
