// test/orientation-bench.test.ts — W454 Phase 1/3 tooling: the claude result
// parser must extract wall clock + token split honestly (nulls for missing
// fields, error rows for unparseable output).
import { describe, expect, test } from "bun:test";
import { parseClaude } from "../scripts/orientation-bench.ts";

describe("orientation-bench parseClaude", () => {
	test("parses a successful result with usage split", () => {
		const out = JSON.stringify({
			type: "result",
			subtype: "success",
			duration_ms: 4211,
			session_id: "s-abc",
			total_cost_usd: 0.01,
			usage: {
				input_tokens: 120,
				output_tokens: 40,
				cache_read_input_tokens: 3200,
				cache_creation_input_tokens: 900,
			},
			result: "abc123",
		});
		const r = parseClaude(out);
		expect(r.ok).toBe(true);
		expect(r.wall_ms).toBe(4211);
		expect(r.input_tokens).toBe(120);
		expect(r.output_tokens).toBe(40);
		expect(r.cache_read).toBe(3200);
		expect(r.cache_creation).toBe(900);
		expect(r.session_id).toBe("s-abc");
	});

	test("nulls for missing usage fields, never guessed", () => {
		const r = parseClaude(JSON.stringify({ session_id: "s-1" }));
		expect(r.ok).toBe(true);
		expect(r.input_tokens).toBeNull();
		expect(r.cache_read).toBeNull();
	});

	test("is_error and unparseable output are not ok", () => {
		expect(parseClaude(JSON.stringify({ is_error: true })).ok).toBe(false);
		expect(parseClaude("garbage, no json").ok).toBe(false);
	});
});
