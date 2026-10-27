// wire-model-check.test.ts — W1302.6 (O3): the requested-vs-served wire model
// assertion for review receipts. The W1278.1 review was requested as
// glm-5.3-flash and served by chatgpt/gpt-6-sol but landed as a clean PASS.

import { expect, test } from "@playwright/test";
import {
	modelCore,
	wireModelAudit,
	wireModelMatch,
} from "../hooks/lib/gates/wire-model-check.ts";

test.describe("modelCore", () => {
	test("strips provider prefix, variant suffix; unifies dots to dashes", () => {
		expect(modelCore("zai-glm-5.3-flash")).toBe("zai-glm-5-3-flash");
		expect(modelCore("chatgpt/gpt-6-sol")).toBe("gpt-6-sol");
		expect(modelCore("GLM-5.3-Flash")).toBe("glm-5-3-flash");
		expect(modelCore("provider/nested/model:free")).toBe("model");
	});
});

test.describe("wireModelMatch", () => {
	test("equal cores and dash-boundary alias extensions match", () => {
		expect(wireModelMatch("glm-5.3-flash", "glm-5.3-flash")).toBe("match");
		// routing-stamped upstream alias serves the same class (O3 evidence)
		expect(wireModelMatch("glm-5.3-flash", "zai-glm-5.3-flash")).toBe("match");
		// dots-to-dashes alias law is data (root AGENTS.md)
		expect(wireModelMatch("claude-sonnet-5-5", "claude-sonnet-5.5")).toBe(
			"match",
		);
		expect(wireModelMatch("gpt-4o", "openai/gpt-4o")).toBe("match");
		// dated snapshot stamps are the same class served (W1814: the haiku
		// review leg serves claude-haiku-4-5-20251001 for claude-haiku-4-5)
		expect(
			wireModelMatch("claude-haiku-4-5", "claude-haiku-4-5-20251001"),
		).toBe("match");
		expect(
			wireModelMatch("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
		).toBe("match");
	});

	test("other model classes mismatch", () => {
		// the exact O3 incident pair
		expect(wireModelMatch("glm-5.3-flash", "chatgpt/gpt-6-sol")).toBe(
			"mismatch",
		);
		expect(wireModelMatch("glm-5.3-flash", "grok-4-flash")).toBe("mismatch");
		// flash vs full tier of the same family is a different class
		expect(wireModelMatch("glm-5.3-flash", "glm-5.3")).toBe("mismatch");
		// a non-numeric dash extension is a generation bump, not a stamp
		expect(wireModelMatch("glm-5", "glm-5-3-flash")).toBe("mismatch");
		expect(wireModelMatch("claude-haiku-4-5", "claude-haiku-4-5-latest")).toBe(
			"mismatch",
		);
	});
});

test.describe("wireModelAudit", () => {
	test("unknown request or served model never blocks (fail-open on absent)", () => {
		expect(wireModelAudit(null, "glm-5.3-flash")).toBeNull();
		expect(wireModelAudit("glm-5.3-flash", null)).toBeNull();
		expect(wireModelAudit("", "glm-5.3-flash")).toBeNull();
		expect(wireModelAudit("  ", "glm-5.3-flash")).toBeNull();
	});

	test("records the pair and the verdict", () => {
		expect(wireModelAudit("glm-5.3-flash", "chatgpt/gpt-6-sol")).toMatchObject({
			requested: "glm-5.3-flash",
			served: "chatgpt/gpt-6-sol",
			match: "mismatch",
		});
		expect(wireModelAudit("glm-5.3-flash", "zai-glm-5.3-flash")).toMatchObject({
			match: "match",
		});
	});
});
