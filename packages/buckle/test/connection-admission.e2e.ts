import { expect, test } from "@playwright/test";
import { Router } from "../src/router.ts";
import { tryOnce } from "../src/router-attempt.ts";

test("disabled connection discovery hides only the catalog without inventing serving caps", async () => {
	const { createApp } = await import("../src/handlers.ts");
	const { testDeps } = await import("./deps.ts");
	const pool = {
		groups: () => ["hidden", "shown"],
		deployments: (group: string) => [
			{
				group,
				url: "https://peer.example/v1",
				dialect: "openai" as const,
				discover: group !== "hidden",
			},
		],
	};
	const app = createApp(testDeps(pool));
	const response = await app.fetch(new Request("http://buckle.test/v1/models"));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		object: "list",
		data: [{ id: "shown", object: "model", owned_by: "buckle" }],
	});
});

test("relay limit holds through body EOF without creating provider-account pressure", async () => {
	const dep = {
		group: "selected",
		url: "https://peer.example/v1",
		dialect: "openai" as const,
		buckle: true,
		providerProfile: "peer-one",
		connection_limit: 1,
	};
	const pool = { groups: () => ["selected"], deployments: () => [dep] };
	let calls = 0;
	const router = new Router(
		{},
		{
			pool,
			fetchImpl: async () => {
				calls++;
				return Response.json({ ok: true });
			},
		},
	);
	const request = {
		group: "selected",
		dialect: "openai" as const,
		path: "/v1/chat/completions",
		body: { model: "selected", messages: [] },
		key: "fixture",
	};
	const first = await tryOnce(router, request, dep, 1000);
	expect(first.ok).toBe(true);
	const blocked = await tryOnce(router, request, dep, 1000);
	expect(blocked).toMatchObject({
		ok: false,
		localAdmission: true,
		providerPool: null,
		status: 503,
	});
	expect(calls).toBe(1);
	expect(router.providerAdmissionSnapshot()).toEqual({});
	if (!first.ok) throw Error("First response absent");
	await first.response.text();
	const next = await tryOnce(router, request, dep, 1000);
	expect(next.ok).toBe(true);
	expect(calls).toBe(2);
	if (next.ok) await next.response.body?.cancel();
	const afterCancel = await tryOnce(router, request, dep, 1000);
	expect(afterCancel.ok).toBe(true);
	expect(calls).toBe(3);
	if (afterCancel.ok) await afterCancel.response.text();
});

test("startup rejects malformed connection controls from the actual upstream file", async () => {
	const { scratchWorld } = await import("@klh/test-kit");
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { loadUpstreams } = await import("../src/upstreams.ts");
	const world = scratchWorld(),
		previous = process.env.BUCKLE_UPSTREAMS;
	try {
		delete process.env.BUCKLE_UPSTREAMS;
		const file = join(world.home, "upstreams.json");
		for (const controls of [{ connection_limit: 0 }, { discover: "false" }]) {
			writeFileSync(
				file,
				JSON.stringify({
					groups: {
						selected: [
							{
								url: "https://peer.example/v1",
								dialect: "openai",
								...controls,
							},
						],
					},
				}),
			);
			expect(() => loadUpstreams(file)).toThrow(
				"Invalid deployment connection controls",
			);
		}
	} finally {
		if (previous === undefined) delete process.env.BUCKLE_UPSTREAMS;
		else process.env.BUCKLE_UPSTREAMS = previous;
		world.clean();
	}
});
