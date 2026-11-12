import { stashPrincipal } from "../src/gov/federation.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { createApp } from "../src/handlers.ts";
import { Cooldowns } from "../src/cooldown.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import type { ExecuteResult } from "../src/router.ts";
import { startMockUpstream } from "./mock.ts";

const ROOT = "availability-test-root";
const paths = ["/v1/chat/completions", "/v1/messages"];
const payload = (stream: boolean, model = "fixture-model") => ({
	model,
	stream,
	max_tokens: 16,
	messages: [{ role: "user", content: "fixture" }],
});
async function observation(response: Response) {
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = { unexpectedBody: text.slice(0, 4096) };
	}
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		route: response.headers.get("x-belt-route"),
		body,
	};
}

async function emptyServer(home: string, missingConfig = false) {
	const realFetch = globalThis.fetch;
	let ownedPort = 0;
	let refusedOutbound = 0;
	if (missingConfig)
		globalThis.fetch = ((input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.hostname === "127.0.0.1" && url.port === String(ownedPort))
				return realFetch(input, init);
			refusedOutbound++;
			return Promise.reject(new Error("Fixture unavailable: outbound refused"));
		}) as typeof fetch;
	for (const [name, doc] of Object.entries({
		"upstreams.json": { version: 1, inherit_defaults: false, groups: {} },
		"policy.json": { gateway: { num_retries: 0, allowed_fails: 1 } },
		"prefs.json": { allow_cloud: true, cost_speed: "balanced" },
		"repo-policy.json": { rows: [] },
	}))
		if (!missingConfig || name !== "upstreams.json")
			writeFileSync(join(home, name), JSON.stringify(doc), { mode: 0o600 });
	const server = startServer({
		port: 0,
		hostname: "127.0.0.1",
		...(missingConfig ? {} : { upstreamsPath: join(home, "upstreams.json") }),
		policyPath: join(home, "policy.json"),
		prefsPath: join(home, "prefs.json"),
		repoPolicyPath: join(home, "repo-policy.json"),
		dbPath: join(home, "gateway.db"),
		secretsHome: join(home, "secrets"),
		auth: { rootKey: ROOT },
	});
	ownedPort = server.port ?? 0;
	const base = `http://127.0.0.1:${server.port}`;
	const issued: { key: string; key_id: string }[] = [];
	const mint = async (name: string, scopes: string[]) => {
		const response = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ROOT}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ name, scopes }),
		});
		if (!response.ok) {
			const failure = await response.json();
			throw Error(
				`Fixture key mint failed ${response.status}: ${failure.code}`,
			);
		}
		const credential = await response.json();
		issued.push(credential);
		return credential.key as string;
	};
	try {
		const key = await mint("availability-fixture", ["buckle:proxy:WRITE_"]);
		const restricted = await mint("availability-restricted", [
			"buckle:proxy:READ_",
		]);
		const observations = [];
		for (const path of paths)
			for (const stream of [false, true])
				observations.push({
					path,
					stream,
					...(await observation(
						await fetch(`${base}${path}`, {
							method: "POST",
							headers: {
								authorization: `Bearer ${key}`,
								"content-type": "application/json",
							},
							body: JSON.stringify(payload(stream)),
						}),
					)),
				});
		const denied = [];
		for (const token of [null, restricted])
			denied.push(
				await observation(
					await fetch(`${base}/v1/chat/completions`, {
						method: "POST",
						headers: {
							...(token ? { authorization: `Bearer ${token}` } : {}),
							"content-type": "application/json",
						},
						body: JSON.stringify(payload(false, "blocked")),
					}),
				),
			);
		const catalog = await fetch(`${base}/v1/models`, {
			headers: { authorization: `Bearer ${ROOT}` },
		});
		return {
			started: true,
			missingConfig,
			refusedOutbound,
			modelCount: (await catalog.json()).data.length,
			observations,
			denied,
		};
	} finally {
		for (const credential of issued)
			await fetch(`${base}/v1/admin/keys/${credential.key_id}/revoke`, {
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
			});
		await server.stop(true);
	}
}

async function configuredRoutes() {
	let available = true;
	const upstream = await startMockUpstream(() =>
		!available
			? new Response("Unavailable", { status: 503 })
			: Response.json({
					id: "fixture-reply",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "healthy fixture" },
							finish_reason: "stop",
						},
					],
				}),
	);
	try {
		const deployments: Deployment[] = [
			"openrouter",
			"github-copilot",
			"zai",
		].map((provider, index) => ({
			provider,
			group: `model-${index}`,
			model: `model-${index}`,
			url: upstream.url,
			dialect: "openai",
			adapter: "openai-compat",
		}));
		const pool: UpstreamPool = {
			groups: () => deployments.map((dep) => dep.group),
			deployments: (group) => deployments.filter((dep) => dep.group === group),
		};
		const cooldowns = new Cooldowns(1, 60),
			deps = testDeps(pool, { cooldowns }),
			app = createApp(deps);
		const request = (path: string, stream: boolean, model: string) =>
			new Request(`http://gateway.fixture${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload(stream, model)),
			});
		const healthy = [];
		for (const dep of deployments)
			for (const path of paths)
				healthy.push(
					await observation(await app.fetch(request(path, false, dep.group))),
				);
		const inferenceCount = () =>
			upstream.calls.filter((call) => call.body !== null).length;
		const beforeUnavailable = inferenceCount();
		available = false;
		for (const dep of deployments) cooldowns.eject(dep);
		deps.table.rebuild();
		const unavailable = [];
		for (const dep of deployments)
			for (const path of paths)
				for (const stream of [false, true])
					unavailable.push(
						await observation(
							await app.fetch(request(path, stream, dep.group)),
						),
					);
		const unpinned = [];
		for (const path of paths)
			for (const stream of [false, true])
				unpinned.push(
					await observation(
						await app.fetch(request(path, stream, "not-configured")),
					),
				);
		const second = deployments[1];
		if (!second) throw Error("Fixture row absent");
		cooldowns.success(second);
		deps.table.rebuild();
		const pinned = await observation(
			await app.fetch(request(paths[0] ?? "", false, "model-0")),
		);
		const unavailableAttempts = inferenceCount() - beforeUnavailable;
		available = true;
		const recovered = await observation(
			await app.fetch(request(paths[0] ?? "", false, "not-configured")),
		);
		const protectedErrors = [];
		const terminalResults: Extract<ExecuteResult, { kind: "exhausted" }>[] = [
			{
				kind: "exhausted",
				status: 429,
				error: "quota wall",
				attempts: 0,
				retryAfterS: 60,
				quota: true,
			},
			{
				kind: "exhausted",
				status: 429,
				error: "local rate limit",
				attempts: 0,
				retryAfterS: 60,
			},
			{
				kind: "exhausted",
				status: 504,
				error: "walk deadline",
				attempts: 1,
				lastFailure: {
					source: "local-admission",
					status: 504,
					kind: "walk_deadline",
				},
			},
			{
				kind: "exhausted",
				status: 502,
				error: "invalid upstream response",
				attempts: 1,
				lastFailure: { source: "upstream", status: 502, kind: "bad_response" },
			},
		];
		for (const terminal of terminalResults) {
			const terminalDeps = testDeps(pool);
			terminalDeps.router.execute = async () => terminal;
			const terminalApp = createApp(terminalDeps);
			for (const path of paths)
				for (const stream of [false, true])
					protectedErrors.push({
						expected: terminal.status,
						...(await observation(
							await terminalApp.fetch(request(path, stream, "model-0")),
						)),
					});
		}
		const beforeDenied = inferenceCount();
		const scopedApp = createApp(
			testDeps(pool, {
				accountPolicy: {
					version: 1,
					classes: [
						{
							id: "restricted",
							tier: "restricted",
							general: true,
							keys: ["*"],
							providers: ["different-provider"],
						},
					],
				},
			}),
		);
		const deniedRequest = request(paths[0] ?? "", false, "model-0");
		stashPrincipal(deniedRequest, {
			kind: "api_key",
			keyId: "fixture-key",
			name: "ordinary-fixture",
			team: null,
			actor: "ordinary-fixture",
			scopes: ["buckle:proxy:WRITE_"],
			jti: null,
			rpm: null,
			tpm: null,
		});
		const denied = await observation(await scopedApp.fetch(deniedRequest));
		return {
			configured: deployments.length,
			healthy,
			unavailable,
			unpinned,
			pinned,
			denied,
			unavailableAttempts,
			recovered,
			protectedErrors,
			noDeniedOutbound: inferenceCount() === beforeDenied,
		};
	} finally {
		upstream.close();
	}
}

if (import.meta.main) {
	const result =
		process.argv[2] === "empty" || process.argv[2] === "missing"
			? await emptyServer(process.env.HOME ?? "", process.argv[2] === "missing")
			: await configuredRoutes();
	console.log(`AVAILABILITY_RESULT=${JSON.stringify(result)}`);
	process.exit(0);
}
