import { describe, expect, test } from "bun:test";
import {
	beltAssetUp,
	buckleReadProxy,
} from "../hooks/board/buckle-read-proxy.ts";

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

	test("model capability data and renderer are read-only proxied assets", async () => {
		const paths: string[] = [];
		const fakeFetch = ((url: string) => {
			paths.push(url);
			return Promise.resolve(new Response("ok"));
		}) as typeof fetch;
		for (const path of [
			"/api/console/buckle/api/model-capabilities",
			"/console/buckle-assets/dashboard-model-access.js",
		]) {
			const req = request(path);
			expect(
				(await buckleReadProxy(req, new URL(req.url), fakeFetch))?.status,
			).toBe(200);
		}
		expect(paths).toEqual([
			"http://127.0.0.1:7791/api/model-capabilities",
			"http://127.0.0.1:7791/dashboard-model-access.js",
		]);
	});
});

describe("beltAssetUp (W1294.2.1 freshness probe)", () => {
	test("HEADs the newest chunk and reads a 200 as belt-up", async () => {
		const seen: Array<{ url: string; method: string | undefined }> = [];
		const fakeFetch = ((url: string, init: RequestInit) => {
			seen.push({ url, method: init.method });
			return Promise.resolve(new Response(null, { status: 200 }));
		}) as typeof fetch;
		expect(await beltAssetUp(fakeFetch)).toBe(true);
		expect(seen).toEqual([
			{
				url: "http://127.0.0.1:7791/dashboard-topology-hubs.js",
				method: "HEAD",
			},
		]);
	});

	test("404 from a stale runtime home reads as belt-down", async () => {
		const fakeFetch = (() =>
			Promise.resolve(new Response("not found", { status: 404 }))) as typeof fetch;
		expect(await beltAssetUp(fakeFetch)).toBe(false);
	});

	test("fetch throw (feed down) reads as belt-down", async () => {
		const fakeFetch = (() =>
			Promise.reject(new Error("connection refused"))) as typeof fetch;
		expect(await beltAssetUp(fakeFetch)).toBe(false);
	});
});
