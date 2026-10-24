// test/capacity-ramp.test.ts — W1266.1 endpoint-path regression for the
// capacity-ramp RUNNER, kept isolated from the buckle server sources (the
// W1265 merge left committed conflict markers in server.ts/handlers.ts that
// break any test importing src/server.ts — integration owns that repair).
// Imports ONLY bin/capacity-ramp.ts (node builtins only; import.meta.main
// guard keeps main() inert under test).
import { describe, expect, test } from "bun:test";
import { endpointOf } from "../bin/capacity-ramp.ts";

describe("W1266 capacity-ramp endpoint assembly", () => {
	test("direct leg URLs retain the base pathname prefix (live 2026-10-24 404 regression)", () => {
		// new URL("/v1/messages", "https://api.z.ai/api/anthropic") resolves to
		// https://api.z.ai/v1/messages — the leading slash discards the
		// /api/anthropic prefix and every direct request 404s (all 3 legs,
		// reproduced live 2026-10-24 by the coordinator).
		expect(endpointOf("https://api.z.ai/api/anthropic", "anthropic").href).toBe(
			"https://api.z.ai/api/anthropic/v1/messages",
		);
		expect(endpointOf("https://api.z.ai/api/coding/paas/v4", "chat").href).toBe(
			"https://api.z.ai/api/coding/paas/v4/chat/completions",
		);
		expect(endpointOf("https://api.z.ai/api/v1", "responses").href).toBe(
			"https://api.z.ai/api/v1/responses",
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
