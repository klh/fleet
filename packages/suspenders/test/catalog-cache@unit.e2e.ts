import { expect, test } from "@playwright/test";
import { cachedConnectionCatalog } from "../deploy/connection-catalog-cache.ts";

test("catalog cache is credential-bound, ages out, and last-good does not mask a failed refresh", async () => {
	const target = {
		kind: "openai" as const,
		source: "https://cache-fixture.example/v1/models",
		headers: {},
	};
	let calls = 0,
		fail = false;
	const fetcher = (async () => {
		calls++;
		return fail
			? new Response("private diagnostic", { status: 503 })
			: Response.json({ data: [{ id: "observed-model" }] });
	}) as unknown as typeof fetch;
	const good = await cachedConnectionCatalog(target, "first", fetcher, 0);
	expect(good.state).toBe("listed");
	expect(await cachedConnectionCatalog(target, "first", fetcher, 100)).toBe(
		good,
	);
	expect(calls).toBe(1);
	await cachedConnectionCatalog(target, "second", fetcher, 100);
	expect(calls).toBe(2);
	fail = true;
	const failed = await cachedConnectionCatalog(
		target,
		"first",
		fetcher,
		61_000,
	);
	expect(failed.state).toBe("provider-failure");
	expect(failed.lastGoodObservedAt).toBe(
		good.state === "listed" ? good.observedAt : null,
	);
	expect(JSON.stringify(failed)).not.toContain("private diagnostic");
	expect("rows" in failed).toBe(false);
});
