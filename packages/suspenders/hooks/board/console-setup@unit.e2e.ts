import { expect, test } from "@playwright/test";
import { gatewaySetup, readSetupInventory } from "./console-setup.ts";
import { readEffectiveUpstreams } from "./console-upstreams.ts";

test("logical connections deduplicate models and protocols without exposing identities", () => {
	const read = (profiles: string[]) =>
		readEffectiveUpstreams({
			basePath: "base",
			readFile: () =>
				JSON.stringify({
					groups: Object.fromEntries(
						["model-a", "model-b"].map((name) => [
							name,
							profiles.flatMap((providerProfile) =>
								["openai", "anthropic"].map((dialect) => ({
									providerProfile,
									dialect,
									url: "https://peer.example/v1",
									api_key_env: "PEER_KEY",
								})),
							),
						]),
					),
				}),
		});
	expect(read(["peer-one"])).toMatchObject({ connections: 1 });
	expect(read(["peer-one", "peer-two"])).toMatchObject({ connections: 2 });
	expect(read(["peer-one"])?.groups.map((group) => group.tiers)).toEqual([
		2, 2,
	]);
	expect(JSON.stringify(read(["peer-one"]))).not.toMatch(
		/peer\.example|PEER_KEY|peer-one/,
	);
});

test("known empty configuration needs setup even when optional inventory is unavailable", () => {
	expect(gatewaySetup([], "up", null, 0).state).toBe("unconfigured");
	expect(
		gatewaySetup([{ name: "model", tiers: 1, dormant: false }], "up", null, 1)
			.state,
	).toBe("unknown");
});

test("legacy wire bases deduplicate by endpoint and credential reference; ambiguous rows stay unknown", () => {
	const read = (entries: unknown[]) =>
		readEffectiveUpstreams({
			basePath: "base",
			readFile: () => JSON.stringify({ groups: { model: entries } }),
		});
	const endpoint = {
		url: "https://peer.example",
		dialect: "anthropic",
		api_key_env: "PEER_KEY",
	};
	expect(
		read([
			endpoint,
			{ ...endpoint, url: "https://peer.example/v1/", dialect: "openai" },
		])?.connections,
	).toBe(1);
	expect(
		read([endpoint, { ...endpoint, api_key_env: "OTHER_KEY" }])?.connections,
	).toBe(2);
	for (const row of [
		{},
		{ ...endpoint, providerProfile: "" },
		{ ...endpoint, url: "not a URL" },
		{ ...endpoint, api_key: "private-value" },
		{ ...endpoint, url: "https://peer.example?token=private-value" },
	])
		expect(read([row])?.connections).toBeNull();
	expect(JSON.stringify(read([endpoint]))).not.toMatch(
		/peer\.example|PEER_KEY/,
	);
});

test("standalone override disables phantom defaults without requiring a base file", () => {
	const result = readEffectiveUpstreams({
		basePath: "absent",
		overridePath: "override",
		hasFile: (p) => p === "override",
		readFile: (p) => {
			if (p === "absent") throw new Error("absent");
			return JSON.stringify({ inherit_defaults: false, groups: {} });
		},
	});
	expect(result).toEqual({
		groups: [],
		source: "machine override",
		connections: 0,
	});
});

test("setup separates empty, unavailable, advertised and failed observations", () => {
	const configured = [{ name: "any-model", tiers: 1, dormant: false }];
	expect(gatewaySetup([], "up", 0, 0).state).toBe("unconfigured");
	expect(gatewaySetup(configured, "down", 1, 1).state).toBe(
		"configured-unavailable",
	);
	expect(gatewaySetup(configured, "up", 1, 1).state).toBe("ready");
	expect(gatewaySetup(configured, "up", null, 1).state).toBe("unknown");
	expect(gatewaySetup(configured, "down", null, 1).state).toBe(
		"configured-unavailable",
	);
	expect(gatewaySetup(null, "up", 0, null).state).toBe("unknown");
	expect(gatewaySetup(configured, "up", 0, 1).state).toBe(
		"configured-unavailable",
	);
	expect(JSON.stringify(gatewaySetup(configured, "up", 1, 1))).not.toContain(
		"any-model",
	);
});

test("inventory errors and stale or malformed feeds are unknown, not empty", async () => {
	for (const response of [
		new Response("unavailable", { status: 503 }),
		Response.json({}),
		Response.json({ generatedAt: "2000-01-01", models: [] }),
	]) {
		expect(await readSetupInventory(async () => response)).toBeNull();
	}
	expect(
		await readSetupInventory(async () =>
			Response.json({ generatedAt: new Date().toISOString(), models: [] }),
		),
	).toBe(0);
});

test("inventory body has a whole-operation deadline and byte bound", async () => {
	const stalled = new Response(
		new ReadableStream({
			pull() {
				return new Promise(() => {});
			},
		}),
	);
	expect(await readSetupInventory(async () => stalled, 25)).toBeNull();
	expect(
		await readSetupInventory(async () => new Response("x".repeat(1_048_577))),
	).toBeNull();
});

test("shipped presets and undated catalog entries cannot masquerade as operator setup", async () => {
	expect(
		gatewaySetup(
			[{ name: "preset", tiers: 1, dormant: false, source: "fleet default" }],
			"up",
			0,
			1,
		),
	).toMatchObject({ state: "unconfigured", defaultsOnly: true });
	const observation = (exposures: unknown[]) =>
		Response.json({
			generatedAt: new Date().toISOString(),
			models: [{ id: "model", exposures }],
		});
	expect(
		await readSetupInventory(async () =>
			observation([{ evidence: "catalog", state: "unknown" }]),
		),
	).toBeNull();
	expect(
		await readSetupInventory(async () =>
			observation([
				{
					evidence: "configured",
					state: "up",
					observedAt: new Date().toISOString(),
				},
			]),
		),
	).toBeNull();
	expect(
		await readSetupInventory(async () =>
			observation([
				{
					evidence: "catalog",
					state: "up",
					observedAt: new Date().toISOString(),
				},
			]),
		),
	).toBe(1);
});

test("fresh observations must match this gateway's configured route identities", async () => {
	const read = async () =>
		Response.json({
			generatedAt: new Date().toISOString(),
			models: [
				{
					id: "underlying",
					exposures: [
						{
							evidence: "catalog",
							state: "up",
							observedAt: new Date().toISOString(),
							routeModel: "own-route",
						},
					],
				},
			],
		});
	expect(await readSetupInventory(read, 100, ["unrelated-route"])).toBeNull();
	expect(await readSetupInventory(read, 100, ["own-route"])).toBe(1);
	expect(
		await readSetupInventory(async () => new Promise(() => {}), 25),
	).toBeNull();
});

test("explicit missing override refuses fallback and disabled inheritance discards actual presets", () => {
	expect(
		readEffectiveUpstreams({
			basePath: "base",
			overridePath: "missing",
			overrideRequired: true,
			hasFile: () => false,
			readFile: () => '{"groups":{"preset":[{}]}}',
		}),
	).toBeNull();
	expect(
		readEffectiveUpstreams({
			basePath: "base",
			overridePath: "override",
			hasFile: () => true,
			readFile: (p) =>
				p === "base"
					? '{"groups":{"preset":[{}]}}'
					: '{"inherit_defaults":false,"groups":{"own":[{}]}}',
		})?.groups,
	).toEqual([
		{ name: "own", tiers: 1, dormant: false, source: "machine override" },
	]);
});
