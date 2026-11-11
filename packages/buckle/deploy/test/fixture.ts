import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { scratchWorld, serveStub } from "@klh/test-kit";

export async function fixture() {
	const world = scratchWorld(),
		rootKey = randomBytes(32).toString("hex"),
		upstreamKey = randomBytes(32).toString("hex");
	const stub = serveStub(
		async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "GET" && path === "/v1/models")
				return Response.json({
					object: "list",
					data: [{ id: "seed-model", object: "model" }],
				});
			if (request.method !== "POST" || path !== "/v1/chat/completions")
				return new Response("fixture path missing", { status: 404 });
			if (request.headers.get("authorization") !== `Bearer ${upstreamKey}`)
				return new Response("fixture denied", { status: 401 });
			const frames = [
				{
					id: "fixture",
					object: "chat.completion.chunk",
					choices: [
						{ index: 0, delta: { content: "one " }, finish_reason: null },
					],
				},
				{
					id: "fixture",
					object: "chat.completion.chunk",
					choices: [
						{ index: 0, delta: { content: "two" }, finish_reason: "stop" },
					],
				},
				{
					id: "fixture",
					object: "chat.completion.chunk",
					choices: [],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
				},
			];
			return new Response(
				new ReadableStream({
					async start(controller) {
						for (const frame of frames) {
							controller.enqueue(
								new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
							);
							await Bun.sleep(60);
						}
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		{ hostname: "0.0.0.0" },
	);
	const site = join(world.home, "site");
	await mkdir(site, { mode: 0o755 });
	const configs = {
		"upstreams.json": {
			version: 1,
			inherit_defaults: false,
			groups: {
				"seed-model": [
					{
						provider: "fixture",
						url: `http://host.docker.internal:${stub.port}`,
						dialect: "openai",
						model: "seed-model",
						api_key_env: "SEED_FIXTURE_UPSTREAM_KEY",
						adapter: "openai-compat",
						group: "seed-model",
					},
				],
			},
		},
		"policy.json": {
			num_retries: 0,
			request_timeout_s: 5,
			tags: { "seed-model": ["locality:hub-local"] },
		},
		"prefs.json": { allow_cloud: true, cost_speed: "balanced" },
		"account-policy.json": {
			version: 1,
			classes: [
				{
					id: "fixture",
					tier: "fixture",
					general: true,
					keys: ["*"],
					providers: ["fixture"],
					groups: ["seed-model"],
				},
			],
		},
	};
	for (const [name, value] of Object.entries(configs)) {
		await Bun.write(join(site, name), JSON.stringify(value));
		await chmod(join(site, name), 0o644);
	}
	const lines = [
		`BUCKLE_ROOT_KEY=${rootKey}`,
		`SEED_FIXTURE_UPSTREAM_KEY=${upstreamKey}`,
		"BUCKLE_UPSTREAMS=/site/upstreams.json",
		"BUCKLE_POLICY=/site/policy.json",
		"BUCKLE_PREFS=/site/prefs.json",
		"BUCKLE_HTTP_UPSTREAM_HOSTS=host.docker.internal",
		"BUCKLE_RESIDENCY_LOCALITY=hub-local",
		"BUCKLE_REPO_TIER_POLICY=/site/account-policy.json",
	];
	for (const [name, values] of [
		["runtime", lines],
		["neutral", lines.filter((line) => !line.startsWith("BUCKLE_UPSTREAMS="))],
		[
			"unauthenticated",
			lines.filter((line) => !line.startsWith("BUCKLE_ROOT_KEY=")),
		],
	] as const) {
		const file = join(world.home, `${name}.env`);
		await Bun.write(file, `${values.join("\n")}\n`);
		await chmod(file, 0o600);
	}
	return { world, stub, site, rootKey, upstreamKey };
}
