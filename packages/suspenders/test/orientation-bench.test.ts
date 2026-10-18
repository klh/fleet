// test/orientation-bench.test.ts — W454 Phase 1/3 tooling: the claude result
// parser must extract wall clock + token split honestly (nulls for missing
// fields, error rows for unparseable output).
import { describe, expect, test } from "bun:test";
import { parseClaude, parseCodex } from "../scripts/orientation-bench.ts";

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

	test("is_error and unparseable usage event is not ok", () => {
		expect(parseClaude(JSON.stringify({ is_error: true })).ok).toBe(false);
		expect(parseClaude("garbage, no json").ok).toBe(false);
	});
});

// W808: the codex `exec --json` JSONL contract, verified live on 0.158 —
// thread.started carries thread_id, turn.completed carries the usage split,
// summed across turns. input INCLUDES cached (OpenAI semantics); fresh =
// input − cached downstream.
describe("orientation-bench parseCodex", () => {
	const jsonl = [
		`{"type":"thread.started","thread_id":"01t-abc"}`,
		`{"type":"turn.started"}`,
		`{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"READY"}}`,
		`{"type":"turn.completed","usage":{"input_tokens":64137,"cached_input_tokens":38912,"cache_write_input_tokens":0,"output_tokens":12}}`,
	].join("\n");

	test("sums usage across turns and carries the thread id", () => {
		const two = `${jsonl}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 3 } })}`;
		const r = parseCodex(two);
		expect(r.ok).toBe(true);
		expect(r.session_id).toBe("01t-abc");
		expect(r.input_tokens).toBe(64237);
		expect(r.cache_read).toBe(38972);
		expect(r.output_tokens).toBe(15);
	});

	test("input INCLUDES cached (fresh = input − cached downstream)", () => {
		const r = parseCodex(jsonl);
		expect(r.input_tokens).toBe(64137);
		expect(r.cache_read).toBe(38912);
	});
});
