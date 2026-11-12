import { expect, test } from "@playwright/test";
import { validateProviderConfig } from "@klh/settings/connections";
import { emitPeerUpstreams } from "@klh/belt/bin/connection-upstreams.ts";

test("native emitter queries only selected peers, combines exact IDs and preserves local routes", async () => {
	const profiles = validateProviderConfig(
		Object.fromEntries(
			["one", "two"].map((name) => [
				name,
				{
					kind: "buckle",
					adapter: "buckle",
					endpoints: { openai: `https://${name}.example/v1` },
					auth: { kind: "inline", key: `${name}-sentinel` },
					env: `${name.toUpperCase()}_KEY`,
				},
			]),
		),
	);
	const calls: string[] = [];
	const fetcher = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		calls.push(String(input));
		expect(new Headers(init?.headers).get("authorization")).toMatch(
			/^Bearer (one|two)-sentinel$/,
		);
		return Response.json({
			data: [
				{
					id: "exact-model",
					context_length: 1000,
					max_output_tokens: 100,
					reasoning: true,
					capability_source: "operator-pinned",
				},
			],
		});
	}) as unknown as typeof fetch;
	const doc = JSON.parse(
		await emitPeerUpstreams(
			["one", "two"],
			{
				local: [
					{
						url: "http://127.0.0.1:8902",
						dialect: "openai",
						model: "local-real-id",
					},
				],
			},
			profiles,
			fetcher,
		),
	);
	expect(calls.sort()).toEqual([
		"https://one.example/v1/models",
		"https://two.example/v1/models",
	]);
	expect(doc.inherit_defaults).toBe(false);
	expect(
		doc.groups["exact-model"].map(
			(row: { providerProfile: string }) => row.providerProfile,
		),
	).toEqual(["one", "two"]);
	expect(doc.groups["exact-model"][0].capabilities).toEqual({
		context_length: 1000,
		max_output_tokens: 100,
		reasoning: true,
		capability_source: "operator-pinned",
	});
	expect(doc.groups.local[0].model).toBe("local-real-id");
	expect(JSON.stringify(doc)).not.toContain("sentinel");
});

test("native emitter refuses direct provider profiles before making a catalog request", async () => {
	const profiles = validateProviderConfig({
		direct: {
			kind: "provider",
			provider: "fixture",
			adapter: "openai",
			endpoints: { openai: "https://direct.example/v1" },
		},
	});
	let calls = 0;
	const fetcher = (async () => {
		calls++;
		return Response.json({ data: [] });
	}) as unknown as typeof fetch;
	await expect(
		emitPeerUpstreams(["direct"], {}, profiles, fetcher),
	).rejects.toThrow("Buckle peer");
	expect(calls).toBe(0);
});
