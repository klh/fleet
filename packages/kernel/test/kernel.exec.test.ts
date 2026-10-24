import { describe, expect, test } from "bun:test";
import { have, lines, run } from "../src/kernel.exec.module.ts";

describe("kernel exec (promoted run.ts)", () => {
	test("run captures combined output and ok/status", () => {
		const r = run("echo", ["hello"]);
		expect(r.ok).toBe(true);
		expect(r.status).toBe(0);
		expect(r.out).toContain("hello");
	});

	test("run reports failure without throwing", () => {
		const r = run("false");
		expect(r.ok).toBe(false);
		expect(r.status).toBe(1);
	});

	test("run surfaces spawn failure honestly (no throw)", () => {
		// a binary that never exists fails spawn (status null/undefined per
		// runtime) → the ONE retry runs, then the failure surfaces
		const r = run("/nonexistent-binary-w1254", []);
		expect(r.ok).toBe(false);
		expect(r.out).toBe("");
	});

	test("lines truncates to n lines", () => {
		expect(lines("a\nb\nc", 2)).toBe("a\nb");
		expect(lines("a", 5)).toBe("a");
	});

	test("have caches its verdict", () => {
		expect(have("sh")).toBe(true);
		expect(have("sh")).toBe(true); // second read rides the cache
	});
});
