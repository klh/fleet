import { describe, expect, test } from "bun:test";
import { buckleReadProxy } from "../hooks/board/buckle-read-proxy.ts";

const request = (path: string, method = "GET") =>
	new Request(`http://suspenders.local${path}`, { method });

describe("Buckle console read proxy", () => {
	test("forwards only allowed reads to the local Belt observation feed", async () => {
		const calls: Array<{ url: string; method: string | undefined }> = [];
		const fakeFetch = ((url: string, init: RequestInit) => {
			calls.push({ url, method: init.method });
			return Promise.resolve(
				new Response('{"ok":true}', {
					headers: {
						"content-type": "application/json",
						"set-cookie": "must-not-pass=1",
					},
				}),
			);
		}) as typeof fetch;
		const req = request("/api/console/buckle/api/model-inventory?q=glm");
		const response = await buckleReadProxy(req, new URL(req.url), fakeFetch);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ ok: true });
		expect(response?.headers.has("set-cookie")).toBe(false);
		expect(calls).toEqual([
			{
				url: "http://127.0.0.1:7791/api/model-inventory?q=glm",
				method: "GET",
			},
		]);
	});

	test("rejects writes and unlisted paths without contacting Belt", async () => {
		const fakeFetch = (() => {
			throw new Error("must not fetch");
		}) as typeof fetch;
		const write = request("/api/console/buckle/api/status", "POST");
		expect(
			(await buckleReadProxy(write, new URL(write.url), fakeFetch))?.status,
		).toBe(405);
		const unknown = request("/api/console/buckle/api/route");
		expect(
			(await buckleReadProxy(unknown, new URL(unknown.url), fakeFetch))?.status,
		).toBe(404);
	});
});
