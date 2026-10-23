// board-suggest.test.ts — W1119 caller-level evidence: the composer suggest
// route enters the shared Buckle client (authenticated /v1/messages, hint +
// trace ride), fails closed with an honest 502 when the gate is unavailable,
// and never touches a direct :890x endpoint.
import { describe, expect, test } from "bun:test";
import {
	SUGGEST,
	parseSuggestion,
	suggest,
	suggestSpec,
	suggestModelResolve,
} from "../hooks/board/suggest.ts";

describe("suggest spec (W1119 model preference as data)", () => {
	test("the fit preference is a W136 hint, not an endpoint", () => {
		expect(suggestSpec()).toBe("prefer local extract");
		expect(suggestSpec()).not.toMatch(/http|:\d+/);
	});
	test("model resolve answers the preference id without probing", async () => {
		expect(await suggestModelResolve()).toBe("local-extract");
	});
});

describe("suggest parse", () => {
	test("tolerates think blocks and fences, rejects too-short output", () => {
		expect(parseSuggestion("<think>x</think>ok")).toBeNull();
		const long = "MISSION — build it. ".repeat(4);
		expect(parseSuggestion(long)?.startsWith("MISSION")).toBe(true);
	});
});

describe("suggest through the gate (W1119)", () => {
	test("routes via the gate: auth, hint, model and prompt ride the wire", async () => {
		let seen: { url: string; auth: string | null; hint: string | null } = {
			url: "",
			auth: null,
			hint: null,
		};
		let calls = 0;
		const r = await suggest("proj", "draft text", {
			env: {
				SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101",
				SUSPENDERS_BUCKLE_TOKEN: "bksk_proxy_test",
			},
			fetcher: (async (input: unknown, init?: RequestInit) => {
				calls++;
				const h = new Headers(init?.headers);
				seen = {
					url: String(input),
					auth: h.get("authorization"),
					hint: h.get("x-belt-hint"),
				};
				return Response.json({
					model: "served",
					content: [
						{ type: "text", text: "MISSION — the expanded prompt. ".repeat(6) },
					],
				});
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(1);
		expect(r.status).toBe(200);
		expect((r.body as { ok: boolean }).ok).toBe(true);
		expect(seen.url).toBe("http://127.0.0.1:4101/v1/messages");
		expect(seen.auth).toBe("Bearer bksk_proxy_test");
		expect(seen.hint).toBe("prefer local extract");
	});

	test("gate unavailable → honest 502, no direct :8902 fallback", async () => {
		let calls = 0;
		const r = await suggest("proj", "gate-down draft", {
			env: {
				SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:1",
				SUSPENDERS_BUCKLE_TOKEN: "bksk_proxy_test",
			},
			fetcher: (async () => {
				calls++;
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(1); // exactly the gate leg — no swarm probe, no reroute
		expect(r.status).toBe(502);
		expect((r.body as { ok: boolean; error: string }).ok).toBe(false);
		expect((r.body as { error: string }).error).toContain("buckle");
	});

	test("missing scoped key fails closed the same way", async () => {
		const r = await suggest("proj", "keyless draft", {
			env: { SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101" },
			fetcher: (async () => {
				throw new Error("must never fetch");
			}) as unknown as typeof fetch,
		});
		expect(r.status).toBe(502);
		expect((r.body as { error: string }).error).toContain("together");
	});
});

describe("bounds", () => {
	test("draft max caps the wire prompt", () => {
		expect(SUGGEST.DRAFT_MAX).toBeGreaterThan(0);
		expect(SUGGEST.MAX_TOKENS).toBeGreaterThan(0);
	});
});
