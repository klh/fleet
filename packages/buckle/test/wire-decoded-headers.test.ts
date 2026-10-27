// test/wire-decoded-headers.test.ts — W2177: fetch decodes a gzip upstream
// body, so the relayed response must drop content-encoding/content-length.
// A hub that forwarded them made the spoke gunzip plain JSON (ZlibError 500).
import { describe, expect, test } from "bun:test";
import type { UpstreamRequest } from "../src/router.ts";
import { defaultFetch } from "../src/wire.ts";
import { startMockUpstream } from "./mock.ts";

const dep = (url: string) => ({
	group: "g",
	url,
	dialect: "anthropic" as const,
});
const req = {
	group: "g",
	dialect: "anthropic",
	path: "/v1/messages",
	body: { model: "m", messages: [], stream: false },
	key: "",
} as UpstreamRequest;

const gzipUpstream = () =>
	startMockUpstream(async () => {
		const json = JSON.stringify({ type: "message", content: "ok" });
		return new Response(Bun.gzipSync(new TextEncoder().encode(json)), {
			headers: {
				"content-type": "application/json",
				"content-encoding": "gzip",
			},
		});
	});

describe("W2177 decoded upstream headers", () => {
	test("relayed response carries no stale content-encoding or length", async () => {
		const up = await gzipUpstream();
		try {
			const resp = await defaultFetch(dep(up.url), req, 5_000);
			expect(resp.headers.get("content-encoding")).toBeNull();
			expect(resp.headers.get("content-length")).toBeNull();
			expect(await resp.json()).toEqual({ type: "message", content: "ok" });
		} finally {
			up.close();
		}
	});

	test("a second hop reads the relayed body without a ZlibError", async () => {
		const up = await gzipUpstream();
		const hub = Bun.serve({
			port: 0,
			fetch: () => defaultFetch(dep(up.url), req, 5_000),
		});
		try {
			const spoke = await fetch(`http://127.0.0.1:${hub.port}/v1/messages`);
			expect(spoke.status).toBe(200);
			expect(await spoke.json()).toEqual({ type: "message", content: "ok" });
		} finally {
			hub.stop(true);
			up.close();
		}
	});
});
