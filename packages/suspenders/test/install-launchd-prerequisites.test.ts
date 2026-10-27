// test/install-launchd-prerequisites.test.ts — W2177: --with-launchd runs
// unless a step the launchd units depend on failed; an optional step such
// as registerCaddy failing no longer strands every service unregistered.
import { describe, expect, test } from "bun:test";
import type {
	StepName,
	StepOutcomeRow,
	StepStatus,
} from "../scripts/install/install-contract.ts";
import { launchdPrerequisitesHeld } from "../scripts/install/install-run.ts";

const row = (name: StepName, status: StepStatus): StepOutcomeRow => ({
	name,
	status,
	note: "",
});

describe("W2177 launchdPrerequisitesHeld", () => {
	test("optional step failures keep launchd registration on", () => {
		expect(
			launchdPrerequisitesHeld([
				row("syncHarness", "ok"),
				row("registerCaddy", "failed"),
				row("releaseNotify", "failed"),
			]),
		).toBe(true);
	});

	test("a failed prerequisite skips launchd registration", () => {
		expect(
			launchdPrerequisitesHeld([
				row("syncHarness", "failed"),
				row("registerCaddy", "ok"),
			]),
		).toBe(false);
	});

	test("a refused registerLaunchd preflight skips registration", () => {
		expect(launchdPrerequisitesHeld([row("registerLaunchd", "failed")])).toBe(
			false,
		);
	});
});
