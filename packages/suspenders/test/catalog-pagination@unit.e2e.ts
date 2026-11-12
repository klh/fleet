import { expect, test } from "@playwright/test";
import { fetchCatalogWithKey } from "../deploy/hub-catalog-fetch.ts";

test("catalog pages retain exact IDs and share one byte budget", async () => {
	const target = {
		kind: "openai" as const,
		source: "https://pages-fixture.example/v1/models",
		headers: {},
		auth: "anthropic" as const,
	};
	const seen: string[] = [];
	const fetcher = (async (input, init) => {
		const url = new URL(String(input));
		seen.push(url.search);
		expect(new Headers(init?.headers).get("x-api-key")).toBe(
			"fixture-sentinel",
		);
		return Response.json(
			url.searchParams.has("after_id")
				? { data: [{ id: "second" }], has_more: false }
				: { data: [{ id: "first" }], has_more: true, last_id: "first" },
		);
	}) as typeof fetch;
	const good = await fetchCatalogWithKey(target, "fixture-sentinel", fetcher);
	expect(good.state).toBe("listed");
	if (good.state === "listed")
		expect([...good.rows.keys()]).toEqual(["first", "second"]);
	expect(seen).toEqual(["", "?after_id=first"]);
	const capped = await fetchCatalogWithKey(
		{ ...target, maxBytes: 75 },
		"fixture-sentinel",
		fetcher,
	);
	expect(capped.state).toBe("provider-failure");
	expect("rows" in capped).toBe(false);
});

test("unbounded/repeating catalog cursors refuse instead of claiming a partial catalog", async () => {
	let calls = 0;
	const fetcher = (async () => {
		calls++;
		return Response.json({
			data: [{ id: "first" }],
			has_more: true,
			last_id: "first",
		});
	}) as unknown as typeof fetch;
	const result = await fetchCatalogWithKey(
		{
			kind: "openai",
			source: "https://repeat-fixture.example/v1/models",
			headers: {},
		},
		undefined,
		fetcher,
	);
	expect(result.state).toBe("provider-failure");
	expect(calls).toBe(2);
});
