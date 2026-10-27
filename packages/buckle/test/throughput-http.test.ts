import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { DEFAULT_THROUGHPUT_POLICY } from "../../telemetry/src/throughput.ts";

test("actual fallback HTTP settles truthful served identity and exposes it through the existing admin connector", async () => {
	const dir = mkdtempSync(join(tmpdir(), "throughput-http-"));
	const failed = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			Response.json({ error: { message: "fixture failure" } }, { status: 503 }),
	});
	const healthy = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			if (
				req.method === "POST" &&
				((await req.json()) as { stream?: boolean }).stream
			) {
				const frames = [
					{
						id: "fixture",
						object: "chat.completion.chunk",
						model: "actual-model",
						choices: [
							{ index: 0, delta: { content: "useful" }, finish_reason: "stop" },
						],
					},
					{
						choices: [],
						usage: {
							prompt_tokens: 1024,
							completion_tokens: 12,
							total_tokens: 1036,
						},
					},
				];
				return new Response(
					`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
					{
						headers: {
							"content-type": "text/event-stream",
							"x-klh-served-provider": "untrusted-provider",
						},
					},
				);
			}
			return Response.json(
				{
					id: "fixture",
					object: "chat.completion",
					model: "actual-model",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "useful" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 1024,
						completion_tokens: 12,
						total_tokens: 1036,
					},
				},
				{ headers: { "x-klh-served-provider": "untrusted-provider" } },
			);
		},
	});
	const policyPath = join(dir, "policy.json"),
		upstreamsPath = join(dir, "upstreams.json");
	writeFileSync(
		policyPath,
		JSON.stringify({
			gateway: { num_retries: 0, fallbacks: { task: ["fallback"] } },
		}),
	);
	writeFileSync(
		upstreamsPath,
		JSON.stringify({
			inherit_defaults: false,
			groups: {
				task: [
					{
						url: `http://127.0.0.1:${failed.port}`,
						dialect: "openai",
						model: "selected-model",
						provider: "failed-provider",
					},
				],
				fallback: [
					{
						url: `http://127.0.0.1:${healthy.port}`,
						dialect: "openai",
						model: "actual-model",
						provider: "healthy-provider",
						providerProfile: "fixture-profile",
					},
				],
			},
		}),
	);
	const server = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath,
		dbPath: join(dir, "buckle.db"),
		auth: { rootKey: "throughput-fixture-key" },
	});
	const base = `http://127.0.0.1:${server.port}`,
		headers = { authorization: "Bearer throughput-fixture-key" };
	try {
		const response = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { ...headers, "x-klh-served-provider": "spoofed-client" },
			body: JSON.stringify({
				model: "task",
				messages: [{ role: "user", content: "fixture" }],
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(response.headers.get("x-klh-served-model")).toBe("actual-model");
		expect(response.headers.get("x-klh-served-provider")).toBe(
			"healthy-provider",
		);
		const requests = await (
			await fetch(`${base}/v1/admin/requests`, { headers })
		).json();
		expect(requests.requests[0]).toMatchObject({
			requested_group: "task",
			target_model: "selected-model",
			served_model: "actual-model",
			served_provider: "healthy-provider",
			served_provider_profile: "fixture-profile",
			out_tok: 12,
		});
		const metrics = await (
			await fetch(`${base}/v1/admin/metrics`, { headers })
		).text();
		expect(metrics).toContain(
			'model="actual-model",provider="healthy-provider"',
		);
		expect(metrics).toContain("buckle_throughput_reported_usage_samples");
		expect(metrics).not.toContain('provider="untrusted-provider"');
		const streamed = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "task",
				stream: true,
				messages: [{ role: "user", content: "fixture" }],
			}),
		});
		expect(streamed.status).toBe(200);
		expect(await streamed.text()).toContain("[DONE]");
		const settled = await (
			await fetch(`${base}/v1/admin/requests`, { headers })
		).json();
		expect(settled.requests[0]).toMatchObject({
			served_model: "actual-model",
			served_provider: "healthy-provider",
			out_tok: 12,
			ok: 1,
		});
	} finally {
		server.stop(true);
		failed.stop(true);
		healthy.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("real HTTP slow cohort degrades while healthy idle and missing usage cohorts remain unflagged", async () => {
	const dir = mkdtempSync(join(tmpdir(), "throughput-baseline-http-"));
	let slow = false;
	const upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			if (req.method === "GET")
				return Response.json({
					data: ["slow", "healthy", "missing", "idle"].map((name) => ({
						id: `${name}-model`,
					})),
				});
			const body = (await req.json()) as { model: string };
			await Bun.sleep(body.model === "slow-model" && slow ? 120 : 25);
			return Response.json({
				id: "fixture",
				object: "chat.completion",
				model: body.model,
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "useful" },
						finish_reason: "stop",
					},
				],
				...(body.model === "missing-model"
					? {}
					: {
							usage: {
								prompt_tokens: 1024,
								completion_tokens: 100,
								total_tokens: 1124,
							},
						}),
			});
		},
	});
	const bucketMs = 300,
		policyPath = join(dir, "policy.json"),
		upstreamsPath = join(dir, "upstreams.json");
	writeFileSync(
		policyPath,
		JSON.stringify({
			gateway: {
				num_retries: 0,
				throughput: {
					...DEFAULT_THROUGHPUT_POLICY,
					bucketMs,
					minSamples: 2,
					baselineBuckets: 3,
					sustainBuckets: 2,
					recoveryBuckets: 2,
				},
			},
		}),
	);
	writeFileSync(
		upstreamsPath,
		JSON.stringify({
			inherit_defaults: false,
			groups: Object.fromEntries(
				["slow", "healthy", "missing", "idle"].map((name) => [
					name,
					[
						{
							url: `http://127.0.0.1:${upstream.port}`,
							dialect: "openai",
							model: `${name}-model`,
							provider: `${name}-provider`,
						},
					],
				]),
			),
		}),
	);
	const server = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath,
		dbPath: join(dir, "buckle.db"),
		auth: { rootKey: "throughput-fixture-key" },
	});
	const base = `http://127.0.0.1:${server.port}`,
		headers = { authorization: "Bearer throughput-fixture-key" };
	const request = async (model: string) => {
		const r = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "fixture" }],
			}),
		});
		expect(r.status).toBe(200);
		await r.text();
	};
	const metrics = async () =>
		await (await fetch(`${base}/v1/admin/metrics`, { headers })).text();
	const incident = (text: string, model: string) =>
		text
			.split("\n")
			.filter(
				(line) =>
					line.startsWith("buckle_throughput_incident_active{") &&
					line.includes(`model="${model}"`),
			)
			.map((line) => Number(line.slice(line.lastIndexOf(" ") + 1)));
	try {
		let observed = "";
		for (let window = 0; window < 5; window++) {
			await Bun.sleep(bucketMs - (Date.now() % bucketMs) + 5);
			slow = window >= 3;
			await Promise.all([
				request("slow"),
				request("slow"),
				request("healthy"),
				request("healthy"),
				request("missing"),
				request("missing"),
			]);
			await metrics(); // captures current-window data without training it
			await Bun.sleep(bucketMs - (Date.now() % bucketMs) + 5);
			observed = await metrics();
		}
		expect(incident(observed, "slow-model")).toEqual([1]);
		expect(incident(observed, "healthy-model")).toEqual([0]);
		expect(incident(observed, "missing-model")).toEqual([0]);
		expect(observed).not.toContain('model="idle-model"');
		const missing = observed
			.split("\n")
			.filter(
				(line) =>
					line.startsWith(
						"buckle_throughput_service_output_tokens_per_second{",
					) && line.includes('model="missing-model"'),
			);
		expect(missing).toEqual([]);
	} finally {
		server.stop(true);
		upstream.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
}, 10_000);
