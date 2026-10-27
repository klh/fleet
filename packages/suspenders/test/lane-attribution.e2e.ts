// test/lane-attribution.test.ts — W918.3: the copilot executor rides the
// same governed Buckle front as claude — one attribution, every executor's
// vars: URL routing for the openai BYOK wire + the scoped lane key in the
// var the copilot CLI actually reads (probe-verified on copilot 1.0.98).
import { expect, test } from "@playwright/test";
import { applyLaneAttribution } from "../hooks/lib/lanes/lane.ts";

test.describe("W918.3 lane attribution — copilot BYOK vars", () => {
	test("governed attribution carries the lane key into the copilot vars", () => {
		const env: Record<string, string> = {};
		applyLaneAttribution(
			env,
			"autow918-3",
			"http://127.0.0.1:4101",
			"bksk_test",
		);
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101/w/autow918-3");
		expect(env.COPILOT_PROVIDER_API_KEY).toBe("bksk_test");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("bksk_test");
	});
	test("attribution overrides the insertion preset with the governed front", () => {
		const env: Record<string, string> = {
			COPILOT_PROVIDER_BASE_URL: "preset-wins-over-insertion",
		};
		applyLaneAttribution(env, "s3", "http://127.0.0.1:4101");
		expect(env.COPILOT_PROVIDER_BASE_URL).toBe("http://127.0.0.1:4101/w/s3/v1");
		expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:4101/w/s3/v1");
	});
	test("keyless attribution keeps URL routing, writes no key vars", () => {
		const env: Record<string, string> = {};
		applyLaneAttribution(env, "s2", "http://127.0.0.1:4101");
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101/w/s2");
		expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
	});
});
