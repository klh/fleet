import { runCli, scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { join, resolve } from "node:path";

test.describe("runner CLI actual workspace smoke @unit", () => {
	test("records both real workspace strategies and replays NDJSON", () => {
		const world = scratchWorld({ prefix: "blam-runner-" });
		try {
			const output = join(world.home, "evidence");
			const producer = resolve(
				import.meta.dir,
				"../bench/runner/workspace-smoke.ts",
			);
			const reporter = resolve(import.meta.dir, "../bench/runner/report.ts");
			const result = runCli(producer, [output, "3"], { env: world.env });
			expect(result.code, result.err).toBe(0);
			const report = JSON.parse(result.out);
			expect(report.issues).toEqual([]);
			expect(report.arms.candidate.runs).toBe(3);
			expect(report.tokenSavingsMeasured).toBe(false);
			expect(report.arms.baseline.readyMs.p50).toBeGreaterThan(0);
			const replay = runCli(reporter, [join(output, "receipts.ndjson")], {
				env: world.env,
			});
			expect(replay.code, replay.err).toBe(0);
			expect(JSON.parse(replay.out)).toEqual(report);
			const duplicate = runCli(producer, [output, "3"], { env: world.env });
			expect(duplicate.code).not.toBe(0);
		} finally {
			world.clean();
		}
	});
});
