import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createRunnerIdentity } from "../hooks/lib/runners/api/identity.ts";
import { openRunnerListener } from "../hooks/lib/runners/api/listener.ts";
import { apiWorld } from "./runner-api.fixture.ts";

test("real loopback runner listener verifies live identity and rejects foreign hosts @unit", async () => {
	const world = apiWorld();
	let revoked = false;
	const authority = serveStub((request) => {
		if (
			revoked ||
			request.headers.get("authorization") !== "Bearer fixture-control"
		)
			return new Response(null, { status: 401 });
		return Response.json({
			authenticated: true,
			kind: "api_key",
			key_id: "alice",
			actor: "root",
			team: null,
			scopes: ["buckle:runner:WRITE_"],
		});
	});
	const listener = openRunnerListener({
		port: 0,
		store: world.store,
		controller: world.controller,
		bindings: world.bindings,
		profiles: {},
		identity: createRunnerIdentity({ baseUrl: authority.url }),
	});
	try {
		const url = new URL("/v1/runner/runs", listener.url);
		const headers = { authorization: "Bearer fixture-control" };
		const first = await fetch(url, { headers });
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ runs: [], nextCursor: null });
		expect(
			(
				await fetch(url, {
					headers: { ...headers, origin: "https://other.invalid" },
				})
			).status,
		).toBe(403);
		expect(
			(await fetch(url, { headers: { ...headers, host: "other.invalid" } }))
				.status,
		).toBe(403);
		revoked = true;
		expect((await fetch(url, { headers })).status).toBe(401);
	} finally {
		await listener.stop();
		authority.close();
		world.close();
	}
});
