// test/capacity-ramp.test.ts — W1266.1 endpoint-path regression for the
// capacity-ramp RUNNER, kept isolated from the buckle server sources (the
// W1265 merge left committed conflict markers in server.ts/handlers.ts that
// break any test importing src/server.ts — integration owns that repair).
// Imports ONLY bin/capacity-ramp.ts (node builtins only; import.meta.main
// guard keeps main() inert under test).
import { expect, test } from "@playwright/test";
import { endpointOf, mintedOf } from "../bin/capacity-ramp.ts";

test.describe({ tag: "@unit" }, () => {
	test.describe("W1266 capacity-ramp endpoint assembly", () => {
		test("direct leg URLs retain the base pathname prefix (live 2026-10-24 404 regression)", () => {
			// new URL("/v1/messages", "https://api.z.ai/api/anthropic") resolves to
			// https://api.z.ai/v1/messages — the leading slash discards the
			// /api/anthropic prefix and every direct request 404s (all 3 legs,
			// reproduced live 2026-10-24 by the coordinator).
			expect(
				endpointOf("https://api.z.ai/api/anthropic", "anthropic").href,
			).toBe("https://api.z.ai/api/anthropic/v1/messages");
			expect(
				endpointOf("https://api.z.ai/api/coding/paas/v4", "chat").href,
			).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
			expect(endpointOf("https://api.z.ai/api/v1", "responses").href).toBe(
				"https://api.z.ai/api/v1/responses",
			);
		});

		test("buckle hop legs expose /v1-prefixed chat+responses paths (live 404 regression)", () => {
			// the gate routes POST /v1/chat/completions and /v1/responses
			// (handlers.ts) — the direct Z.ai suffixes /chat/completions and
			// /responses 404 there (live 2026-10-24). anthropic is already /v1.
			expect(endpointOf("http://127.0.0.1:4101", "anthropic", true).href).toBe(
				"http://127.0.0.1:4101/v1/messages",
			);
			expect(endpointOf("http://127.0.0.1:4101/", "chat", true).href).toBe(
				"http://127.0.0.1:4101/v1/chat/completions",
			);
			expect(endpointOf("http://127.0.0.1:4301", "responses", true).href).toBe(
				"http://127.0.0.1:4301/v1/responses",
			);
			// hop never doubles an existing /v1
			expect(endpointOf("http://127.0.0.1:4101", "chat", true).pathname).toBe(
				"/v1/chat/completions",
			);
		});

		test("prefix-less and trailing-slash bases keep the bare versioned path", () => {
			// buckle spokes/hubs carry no pathname prefix; a trailing slash must
			// not double it
			expect(endpointOf("http://127.0.0.1:4101", "anthropic").href).toBe(
				"http://127.0.0.1:4101/v1/messages",
			);
			expect(endpointOf("http://127.0.0.1:4101/", "chat").href).toBe(
				"http://127.0.0.1:4101/chat/completions",
			);
			expect(endpointOf("http://127.0.0.1:4301/", "responses").href).toBe(
				"http://127.0.0.1:4301/responses",
			);
		});
	});

	test.describe("W1266 capacity-ramp minted-key parsing", () => {
		test("gate mint response maps key_id (id left the test key stranded)", () => {
			expect(mintedOf({ key: "bksk_x", key_id: "abc123" })).toEqual({
				id: "abc123",
				key: "bksk_x",
			});
			// tolerate an id-shaped body too
			expect(mintedOf({ key: "bksk_x", id: "abc123" })).toEqual({
				id: "abc123",
				key: "bksk_x",
			});
			expect(mintedOf({ key_id: "abc123" })).toBeNull();
			expect(mintedOf({ key: "bksk_x" })).toBeNull();
			expect(mintedOf(null)).toBeNull();
		});
	});
});
