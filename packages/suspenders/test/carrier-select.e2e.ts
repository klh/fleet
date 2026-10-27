// W831 total carrier selector — three exits, no fall-through. An unknown or
// offline carrier token is an EXPLICIT refusal; a dispatch never wakes the
// wrong backend by mapping a miss onto claude.
import { expect, test } from "./pw";
import { selectLaneCarrier } from "../scripts/lib/launch-preflight.ts";

const OFFLINE = { HOME: "", PATH: "" };

test("unknown / unspawnable tokens refuse explicitly", () => {
	expect(selectLaneCarrier("grok").ok).toBe(false);
	expect(selectLaneCarrier("grok").why).toContain("unknown carrier");
	expect(selectLaneCarrier("cline").why).toContain("unknown carrier");
	expect(selectLaneCarrier("llm:qwen3:4b").why).toContain("llm:* legs");
});

test("empty token refuses without touching the registry", () => {
	const picked = selectLaneCarrier("   ");
	expect(picked.ok).toBe(false);
	expect(picked.why).toBe("empty carrier token");
});

test("case-normalized, binary-backed carrier selects with its bin", () => {
	const picked = selectLaneCarrier("  CLAUDE ", {
		SUSPENDERS_CLAUDE_BIN: process.execPath,
	});
	expect(picked).toEqual({ ok: true, agent: "claude", bin: process.execPath });
});

test("offline carrier (no resolvable binary) refuses — never a fallback wake", () => {
	const picked = selectLaneCarrier("claude", OFFLINE);
	expect(picked.ok).toBe(false);
	expect(picked.why).toContain("claude binary not found — carrier offline");
});
