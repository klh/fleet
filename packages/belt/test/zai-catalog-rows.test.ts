import { describe, expect, test } from "bun:test";
import {
	validateZaiSnapshot,
	zaiCatalogFile,
	zaiLiteLlmRows,
	ZAI_CATALOG_URL,
	ZaiSnapshotStaleError,
} from "../bin/zai-catalog-rows.ts";

describe("Z.ai LiteLLM account rows", () => {
	test("adds discovered models while leaving configured aliases alone", () => {
		const snapshot = validateZaiSnapshot({
			version: 1,
			source: ZAI_CATALOG_URL,
			generated_at: new Date().toISOString(),
			model_ids: ["glm-4.7", "glm-5.3"],
		});
		const template =
			"  - model_name: zai-glm-5.3\n    litellm_params:\n      model: zai/glm-5.3\n      allowed_openai_params: [reasoning_effort]\n      api_base: https://example.invalid/v4\n      api_key: os.environ/Z_AI_API_KEY";
		const rows = zaiLiteLlmRows(snapshot, template, new Set(["zai-glm-5.3"]));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("model_name: zai-glm-4.7");
		expect(rows[0]).toContain("model: zai/glm-4.7");
		expect(rows[0]).toContain("os.environ/Z_AI_API_KEY");
		expect(rows[0]).toContain("allowed_openai_params: [reasoning_effort]");
		expect(rows[0]).toContain("api_base: https://example.invalid/v4");
	});

	// W1257.1: the generated LiteLLM rows inherit the operator template's
	// api_base verbatim — pointing the remotes.json zai remote at the Coding
	// Plan base (api/coding/paas/v4 for chat-completions, api/anthropic for
	// Claude Code) is the ONLY way the hub chain (Buckle → LiteLLM → Z.ai,
	// whose outbound leg Buckle cannot inspect) stays off the general
	// /api/paas/v4 endpoint. The generator must never rewrite it.
	test("generated rows carry the operator Coding Plan api_base verbatim", () => {
		const snapshot = validateZaiSnapshot({
			version: 1,
			source: ZAI_CATALOG_URL,
			generated_at: new Date().toISOString(),
			model_ids: ["glm-4.7", "glm-5.3"],
		});
		const template =
			"  - model_name: zai-glm-5.3\n    litellm_params:\n      model: zai/glm-5.3\n      allowed_openai_params: [reasoning_effort]\n      api_base: https://api.z.ai/api/coding/paas/v4\n      api_key: os.environ/Z_AI_API_KEY";
		const rows = zaiLiteLlmRows(snapshot, template);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).toContain("api_base: https://api.z.ai/api/coding/paas/v4");
			expect(row).not.toContain("/api/paas/v4");
		}
	});

	test("rejects stale and malformed inventory", () => {
		const raw = {
			version: 1,
			source: ZAI_CATALOG_URL,
			generated_at: new Date(0).toISOString(),
			model_ids: ["glm-5.3"],
		};
		expect(() => validateZaiSnapshot(raw)).toThrow("stale");
		expect(() =>
			validateZaiSnapshot({
				...raw,
				generated_at: new Date().toISOString(),
				model_ids: ["bad/name"],
			}),
		).toThrow("invalid");
	});

	// W1469: the installer repairs ONLY a timestamp failure — it keys on this class.
	test("age failures raise the typed stale error carrying the parsed snapshot", () => {
		const base = { version: 1, source: ZAI_CATALOG_URL, model_ids: ["glm-5.3"] };
		const thrown = (fn: () => unknown): unknown => {
			try {
				fn();
			} catch (error) {
				return error;
			}
		};
		for (const generated_at of [
			new Date(0).toISOString(),
			"not-a-date",
			new Date(Date.now() + 3_600_000).toISOString(),
		]) {
			const error = thrown(() => validateZaiSnapshot({ ...base, generated_at }));
			expect(error).toBeInstanceOf(ZaiSnapshotStaleError);
			expect((error as ZaiSnapshotStaleError).snapshot.model_ids).toEqual([
				"glm-5.3",
			]);
			expect((error as Error).message).toContain("stale; refresh before deploy");
		}
		const invalid = thrown(() =>
			validateZaiSnapshot({ ...base, generated_at: "0", model_ids: ["bad/x"] }),
		);
		expect(invalid).toBeInstanceOf(Error);
		expect(invalid).not.toBeInstanceOf(ZaiSnapshotStaleError);
	});

	test("zaiCatalogFile is the one path: HOME default, ZAI_CATALOG_FILE override", () => {
		expect(zaiCatalogFile("/h", {})).toBe("/h/.claude/local-llm/zai-models.json");
		expect(zaiCatalogFile("/h", { ZAI_CATALOG_FILE: "/x/z.json" })).toBe(
			"/x/z.json",
		);
	});
});
