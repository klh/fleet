import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { startServer } from "../../buckle/src/server.ts";
import { freePort, scratchWorld } from "../../test-kit/src/index.ts";

test("the real gateway generator enables cancellation in private YAML without changing authentication", async () => {
	const { home, clean } = scratchWorld({
		dir: "/tmp",
		prefix: "gateway-cancel-config-",
	});
	try {
		const runtime = join(home, ".claude", "local-llm");
		mkdirSync(runtime, { recursive: true });
		writeFileSync(
			join(runtime, "remotes.json"),
			JSON.stringify({ machines: [] }),
		);
		// Only advisory local inventory discovery is stubbed; generation and
		// private file emission execute the actual production entrypoint.
		const entry = join(home, "generate.ts");
		writeFileSync(
			entry,
			`globalThis.fetch = async () => Response.json({data: []});\nawait import(${JSON.stringify(new URL("../bin/gateway-config.ts", import.meta.url).href)});`,
		);
		const proc = Bun.spawn([process.execPath, entry], {
			env: {
				...process.env,
				HOME: home,
				BELT_POLICY: new URL("../bin/routing-policy.yaml", import.meta.url)
					.pathname,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		expect(await proc.exited, await stderr).toBe(0);
		await stdout;
		const output = join(runtime, "litellm.yaml");
		const config = Bun.YAML.parse(readFileSync(output, "utf8"));
		expect(config.general_settings.cancel_on_disconnect).toBe(true);
		expect(config.general_settings.master_key).toBe("os.environ/LITELLM_KEY");
		expect(statSync(output).mode & 0o777).toBe(0o600);
	} finally {
		clean();
	}
});

test("actual LiteLLM cancels pre-header provider work only when disconnect handling is enabled; streaming cancellation remains intact", async () => {
	const proxyBin = Bun.which("litellm");
	if (!proxyBin)
		throw Error(
			"Install the stack LiteLLM runtime before running this transport integration test",
		);
	const dir = mkdtempSync("/tmp/litellm-cancel-");
	const pause = (ms: number) => Bun.sleep(ms);
	const results = [];
	for (const enabled of [false, true]) {
		let active = 0,
			started = 0,
			aborted = 0,
			completed = 0;
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return Response.json({ data: [] });
				const body = await req.json();
				active++;
				started++;
				let ended = false;
				let timer: ReturnType<typeof setTimeout>;
				let complete!: () => void;
				const done = new Promise<void>((r) => (complete = r));
				const end = (cancel: boolean) => {
					if (ended) return;
					ended = true;
					active--;
					if (cancel) aborted++;
					else completed++;
					clearTimeout(timer);
					complete();
				};
				req.signal.addEventListener("abort", () => end(true), { once: true });
				if (body.stream) {
					const delayed = body.messages?.[0]?.content === "delay-headers";
					if (delayed) {
						await Promise.race([pause(600), done]);
						if (ended) return new Response(null, { status: 499 });
					}
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "fixture" }, finish_reason: null }] })}\n\n`,
									),
								);
								timer = setTimeout(
									() => {
										if (!ended) {
											c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
											c.close();
											end(false);
										}
									},
									delayed ? 600 : 1200,
								);
							},
							cancel() {
								end(true);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				timer = setTimeout(() => end(false), 1200);
				await done;
				return Response.json({
					id: "fixture",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "fixture" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				});
			},
		});
		const proxyPort = await freePort();
		const config = `${dir}/proxy-${enabled}.yaml`;
		writeFileSync(
			config,
			`model_list:\n  - model_name: fixture\n    litellm_params:\n      model: openai/fixture\n      api_base: http://127.0.0.1:${provider.port}/v1\n      api_key: fixture-key\n      max_retries: 0\ngeneral_settings:\n  cancel_on_disconnect: ${enabled}\n`,
			{ mode: 0o600 },
		);
		const proxy = Bun.spawn(
			[
				proxyBin,
				"--config",
				config,
				"--port",
				String(proxyPort),
				"--host",
				"127.0.0.1",
			],
			{
				env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: "True" },
				stdout: Bun.file(`${dir}/proxy-${enabled}.log`),
				stderr: Bun.file(`${dir}/proxy-${enabled}.stderr`),
			},
		);
		let up = false;
		for (let i = 0; i < 200; i++) {
			try {
				up = (
					await fetch(`http://127.0.0.1:${proxyPort}/health/liveliness`, {
						signal: AbortSignal.timeout(200),
					})
				).ok;
			} catch {}
			if (up) break;
			await pause(50);
		}
		if (!up) {
			proxy.kill();
			await proxy.exited;
			provider.stop(true);
			throw Error(`isolated proxy not ready ${dir}`);
		}
		const policyPath = `${dir}/policy.json`,
			rowsPath = `${dir}/rows.json`;
		writeFileSync(
			policyPath,
			JSON.stringify({
				gateway: {
					num_retries: 0,
					provider_pools: {
						account: {
							concurrency: 1,
							intervalCap: 100,
							intervalMs: 1,
							maxOutstanding: 3,
							queueWaitMs: 2000,
							recovery: { successWindow: 8, decreasePercent: 5 },
						},
					},
				},
			}),
		);
		writeFileSync(
			rowsPath,
			JSON.stringify({
				inherit_defaults: false,
				groups: {
					fixture: [
						{
							url: `http://127.0.0.1:${proxyPort}`,
							dialect: "openai",
							adapter_config: {
								provider_pool: "account",
								proxy_kind: "litellm",
							},
						},
					],
				},
			}),
		);
		const front = startServer({
			hostname: "127.0.0.1",
			port: 0,
			policyPath,
			upstreamsPath: rowsPath,
			dbPath: ":memory:",
			auth: { rootKey: "fixture-root" },
		});
		const headers = {
			authorization: "Bearer fixture-root",
			"content-type": "application/json",
		};
		try {
			for (const { stream, preheader } of [
				{ stream: false, preheader: true },
				{ stream: true, preheader: true },
				{ stream: true, preheader: false },
			]) {
				const baseline = { started, aborted, completed };
				const abort = new AbortController();
				const request = fetch(
					`http://127.0.0.1:${front.port}/v1/chat/completions`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							model: "fixture",
							messages: [
								{
									role: "user",
									content: preheader ? "delay-headers" : "fixture",
								},
							],
							stream,
						}),
						signal: abort.signal,
					},
				);
				let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
				if (!preheader) {
					const r = await request;
					reader = r.body?.getReader();
					await reader?.read();
				} else {
					void request.catch(() => {});
					for (let i = 0; i < 200 && started === baseline.started; i++)
						await pause(5);
				}
				await pause(20);
				abort.abort();
				if (reader) await reader.cancel().catch(() => {});
				await pause(150);
				const slots = await (
					await fetch(`http://127.0.0.1:${front.port}/v1/admin/slots`, {
						headers,
					})
				).json();
				results.push({
					enabled,
					stream,
					preheader,
					afterAbort150ms: {
						providerActive: active,
						httpAborts: aborted - baseline.aborted,
						completed: completed - baseline.completed,
						bucklePool: slots.provider_pools.account,
					},
				});
				await pause(1300);
				results.at(-1).afterWorkDeadline = {
					providerActive: active,
					httpAborts: aborted - baseline.aborted,
					completed: completed - baseline.completed,
				};
			}
		} finally {
			front.stop(true);
			proxy.kill();
			await proxy.exited;
			provider.stop(true);
		}
	}
	try {
		console.info(
			JSON.stringify({
				fixture:
					"actual installed LiteLLM, isolated provider, zero external provider calls",
				results,
			}),
		);
		for (const r of results) {
			expect(r.afterAbort150ms.bucklePool.active).toBe(0);
			expect(r.afterAbort150ms.bucklePool.outstanding).toBe(0);
			const cancelled = r.enabled || !r.preheader;
			expect(r.afterAbort150ms.providerActive).toBe(cancelled ? 0 : 1);
			expect(r.afterAbort150ms.httpAborts).toBe(cancelled ? 1 : 0);
			// Without pre-header monitoring, a streaming call is only cancelled
			// when headers finally arrive and the separate stream finalizer runs.
			expect(r.afterWorkDeadline.completed).toBe(
				!r.enabled && !r.stream ? 1 : 0,
			);
			expect(r.afterWorkDeadline.httpAborts).toBe(
				r.enabled || r.stream ? 1 : 0,
			);
			expect(r.afterWorkDeadline.providerActive).toBe(0);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);
