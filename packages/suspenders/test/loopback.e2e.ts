// test/loopback.test.ts — W1256.2: the ONE loopback constants module — URL
// builder, the well-known port map, and the shared hostname predicate.
import { expect, test } from "@playwright/test";
import {
	BELT_DASHBOARD_PORT,
	BUCKLE_SPOKE_PORT,
	isLoopbackHostname,
	LOOPBACK_HOST,
	loopbackUrl,
	LITELLM_PORT,
	MLX_REASON_PORT,
	ROUTER_PORT,
	STORE_PORT,
	BOARD_PORT,
} from "../hooks/lib/loopback.ts";

test.describe("loopback constants", () => {
	test("loopbackUrl builds the 127.0.0.1 form", () => {
		expect(loopbackUrl(4101)).toBe("http://127.0.0.1:4101");
		expect(loopbackUrl(8903, "/v1/chat/completions")).toBe(
			"http://127.0.0.1:8903/v1/chat/completions",
		);
		expect(LOOPBACK_HOST).toBe("127.0.0.1");
	});

	test("well-known ports match the machines-and-processes map", () => {
		expect(ROUTER_PORT).toBe(4000);
		expect(LITELLM_PORT).toBe(4100);
		expect(BUCKLE_SPOKE_PORT).toBe(4101);
		expect(BELT_DASHBOARD_PORT).toBe(7791);
		expect(STORE_PORT).toBe(7794);
		expect(BOARD_PORT).toBe(7799);
		expect(MLX_REASON_PORT).toBe(8903);
	});

	test("isLoopbackHostname normalizes brackets and case", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("::1")).toBe(true);
		expect(isLoopbackHostname("0:0:0:0:0:0:0:1")).toBe(true);
		expect(isLoopbackHostname("LOCALHOST")).toBe(true);
		expect(isLoopbackHostname("nas.threads.dk")).toBe(false);
		expect(isLoopbackHostname("belt.local")).toBe(false);
		expect(isLoopbackHostname("")).toBe(false);
		expect(isLoopbackHostname(null)).toBe(false);
		expect(isLoopbackHostname(undefined)).toBe(false);
	});
});
