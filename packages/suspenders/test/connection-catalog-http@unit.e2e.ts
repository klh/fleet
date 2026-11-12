import { expect, test } from "@playwright/test";
import { fetchCatalogWithKey } from "../deploy/hub-catalog-fetch.ts";
import { readBoundedJson } from "../deploy/catalog-http.ts";

test("catalog bounds response headers and a stalled body without waiting on cancellation", async () => {
	const target = {
		kind: "openai" as const,
		source: "https://fixture.example/v1/models",
		headers: {},
	};
	const started = Date.now();
	const never = (() =>
		new Promise<Response>(() => {})) as unknown as typeof fetch;
	expect(
		(await fetchCatalogWithKey(target, "sentinel-key", never, 30)).state,
	).toBe("provider-failure");
	const stalled = new Response(
		new ReadableStream({
			pull: () => new Promise(() => {}),
			cancel: () => new Promise(() => {}),
		}),
	);
	await expect(
		readBoundedJson(stalled, "catalog", AbortSignal.timeout(30)),
	).rejects.toThrow("timed out");
	expect(Date.now() - started).toBeLessThan(1000);
});

test("catalog credentials stay in headers and failures never copy remote bodies", async () => {
	const observed: RequestInit[] = [];
	const fetcher = (async (
		_url: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		observed.push(init ?? {});
		return new Response("sentinel-key", { status: 401 });
	}) as unknown as typeof fetch;
	const target = {
		kind: "openai" as const,
		source: "https://fixture.example/v1/models",
		headers: {},
		auth: "anthropic" as const,
	};
	const failure = await fetchCatalogWithKey(target, "sentinel-key", fetcher);
	expect(observed[0]?.headers).toMatchObject({ "x-api-key": "sentinel-key" });
	expect(observed[0]?.redirect).toBe("error");
	expect(JSON.stringify(failure)).not.toContain("sentinel-key");
	expect(failure.state).toBe("credential-rejected");
});
