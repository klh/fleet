// test/w1106-bun-idle.test.ts — W1106 owner directive 2026-10-21: NO Bun
// HTTP idle cutoff on any active inference hop, and no fixed client-side
// chat deadline. Bun ignores outgoing bytes when arming the idle timer
// (real-Bun canary), so any fixed value cuts quiet SSE turns; explicit
// app-level guards (Buckle wire.ts, AbortSignal on inventory polls) are
// the only deadlines. Bun does not read idleTimeout back off a server
// object, so these are source-law assertions (the router-shim-parity
// precedent).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const bin = (name: string): string =>
	new URL(`../bin/${name}`, import.meta.url).pathname;

describe("W1106 Bun idle law on active inference hops", () => {
	test("buckle server: idleTimeout pinned 0, env knob retired", () => {
		const src = readFileSync(
			new URL("../../buckle/src/server.ts", import.meta.url).pathname,
			"utf8",
		);
		expect(src).toContain("export const BUN_IDLE_TIMEOUT = 0;");
		expect(src).toContain("idleTimeout: BUN_IDLE_TIMEOUT");
		// the env knob + per-request bypass are retired, not just bypassed
		expect(src).not.toContain("BUCKLE_IDLE_TIMEOUT_S");
		expect(src).not.toContain("resolveIdleTimeout");
		expect(src).not.toContain("srv.timeout(");
	});

	test("belt router-shim: idleTimeout 0 (already the W1106 posture)", () => {
		const src = readFileSync(bin("router-shim.ts"), "utf8");
		expect(src).toContain("idleTimeout: 0");
	});

	test("belt mcp-server: idleTimeout 0 (was 180 on the belt_infer path)", () => {
		const src = readFileSync(bin("mcp-server.ts"), "utf8");
		expect(src).not.toMatch(/idleTimeout:\s*180/);
		expect(src).toContain("idleTimeout: 0");
	});

	test("belt model-proxy: idleTimeout 0 + no fixed chat cutoff", () => {
		const src = readFileSync(bin("model-proxy.ts"), "utf8");
		expect(src).toContain("idleTimeout: 0");
		// the fixed 120s chat deadline is gone; request.signal stays the
		// deadline authority for chat, inventory keeps its 3s poll cap
		expect(src).not.toContain("120_000");
		expect(src).toContain("AbortSignal.timeout(3000)");
		expect(src).toContain("request.signal");
	});
});
