import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchHubRequests } from "./cache-drill.ts";
import { resolveHubEndpoints } from "./cross-hub-usage.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("reads the Buckle admin requests envelope and sends a bounded window", async () => {
	let requested = "";
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		requested = String(input);
		return Response.json({
			requests: [
				{
					rid: "r1",
					ts: "2026-10-19T12:00:00.000Z",
					lane: "lane-one",
					cache_r: 1024,
				},
			],
		});
	}) as typeof fetch;
	const out = await fetchHubRequests("http://hub", "read-key", 7);
	expect(out.ok).toBe(true);
	if (out.ok) expect(out.rows[0]?.cache_r).toBe(1024);
	const url = new URL(requested);
	expect(url.pathname).toBe("/v1/admin/requests");
	expect(url.searchParams.get("limit")).toBe("500");
	expect(url.searchParams.has("since")).toBe(true);
	expect(url.searchParams.has("days")).toBe(false);
});

test("reports a missing request endpoint without inventing cache misses", async () => {
	globalThis.fetch = (async () =>
		new Response(null, { status: 404 })) as typeof fetch;
	expect(await fetchHubRequests("http://hub", "read-key", 7)).toEqual({
		ok: false,
		why: "seam not served (pre-W824 hub)",
	});
});

test("uses a mode-600 stack token file for a registry URL", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-cache-read-"));
	try {
		const keyFile = join(dir, "hub.key");
		const hubsFile = join(dir, "hubs.json");
		writeFileSync(keyFile, "scoped-read-key\n", { mode: 0o600 });
		writeFileSync(
			hubsFile,
			JSON.stringify({ nas: { candidates: ["http://hub"] } }),
		);
		const endpoints = resolveHubEndpoints("nas", {
			env: { SUSPENDERS_HUBS_FILE: hubsFile },
			stack: {
				hubs: { nas: { host: "hub", token_file: keyFile } },
			},
		});
		expect(endpoints).toEqual([
			{ url: "http://hub", via: "hubs.json", token: "scoped-read-key" },
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
