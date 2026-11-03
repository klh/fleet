import { describe, expect, test } from "bun:test";
import { copilotSeatRows } from "../bin/copilot-seat-rows.ts";

// W2595: litellm 1.103.0 ships a native github_copilot provider (Anthropic
// /v1/messages passthrough). These rows are the operator opt-in — the
// 0600 copilot-models.json file names the seat's served model ids and the
// generator maps each to a github_copilot/ leg with background health
// checks off (the copilot API 400s litellm's health probes).
describe("Copilot seat LiteLLM rows", () => {
	test("maps each seat model id to a github_copilot leg", () => {
		const rows = copilotSeatRows(["claude-sonnet-5.5", "gpt-6-sol"]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("model_name: copilot/claude-sonnet-5.5");
		expect(rows[0]).toContain("model: github_copilot/claude-sonnet-5.5");
		expect(rows[1]).toContain("model_name: copilot/gpt-6-sol");
		expect(rows[1]).toContain("model: github_copilot/gpt-6-sol");
		for (const row of rows)
			expect(row).toContain("disable_background_health_check: true");
	});

	test("dedupes ids and keeps a stable order", () => {
		expect(
			copilotSeatRows(["gpt-6-sol", "claude-sonnet-5.5", "gpt-6-sol"]),
		).toEqual(copilotSeatRows(["gpt-6-sol", "claude-sonnet-5.5"]));
	});

	test("an empty list renders an empty catalog (provider stays off)", () => {
		expect(copilotSeatRows([])).toEqual([]);
	});

	test("rejects non-arrays and invalid model ids without echoing them", () => {
		expect(() => copilotSeatRows({ model: "claude-sonnet-5.5" })).toThrow(
			"must be an array",
		);
		for (const bad of [null, 42, "a/b", "UPPER", "", "-lead", "a b"]) {
			expect(() => copilotSeatRows([bad])).toThrow(
				"invalid Copilot seat model",
			);
		}
		expect(() => copilotSeatRows(["x".repeat(200)])).toThrow(
			"invalid Copilot seat model",
		);
	});
});
