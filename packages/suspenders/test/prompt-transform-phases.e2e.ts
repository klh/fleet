// prompt-transform-phases.e2e.ts — W863 orchestrate preview phase map:
// metadata always, content log-gated + redacted, estimates labeled.
import { expect, test } from "@playwright/test";
import {
	PROMPT_DEFAULTS,
	preparePrompt,
	previewView,
	tokenEstimate,
} from "../hooks/board/prompt-transform.ts";
import { phaseDeps, repoLawPhase } from "./helpers/prompt-phase-fixture.ts";

test.describe("@unit W863 context phases", () => {
	test("phase map: metadata always, content log-gated, estimates labeled", async () => {
		const p = await preparePrompt("please add x", PROMPT_DEFAULTS, phaseDeps());
		const plan = { ...p, phases: [repoLawPhase()] };
		const base = previewView(plan);
		const basePhases = base.phases;
		expect(basePhases[0].text).toBeNull();
		expect(basePhases[0].bytes).toBe(20);
		expect(base.wireNote).toContain("estimates");
		const log = previewView({
			...plan,
			settings: { ...PROMPT_DEFAULTS, "prompt.log": true },
		});
		expect(log.phases[0].text).toBe("token: [redacted]");
	});

	test("tokenEstimate is the ≈4-byte heuristic, null-safe", () => {
		expect(tokenEstimate(null)).toBeNull();
		expect(tokenEstimate(9)).toBe(3);
	});
});
