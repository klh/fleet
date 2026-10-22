import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

test("existing private capacity and metrics expose a real queued account lease", async () => {
	const dir = mkdtempSync(join(tmpdir(), "provider-capacity-"));
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let starts = 0;
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ data: [] });
			starts++;
			if (starts === 1) await blocked;
			return Response.json({
				id: "fixture",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "ok" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			});
		},
	});
	const policyPath = join(dir, "policy.json");
	const upstreamsPath = join(dir, "upstreams.json");
	writeFileSync(
		policyPath,
		JSON.stringify({
			gateway: {
				num_retries: 0,
				provider_pools: {
					account: {
						concurrency: 1,
						intervalCap: 10,
						intervalMs: 10,
						maxOutstanding: 4,
						queueWaitMs: 2000,
						recovery: { successWindow: 8, decreasePercent: 5 },
					},
				},
			},
		}),
	);
	writeFileSync(
		upstreamsPath,
		JSON.stringify({
			groups: {
				fixture: [
					{
						url: `http://127.0.0.1:${upstream.port}`,
						dialect: "openai",
						adapter_config: { provider_pool: "account" },
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
		dbPath: ":memory:",
		auth: { rootKey: "capacity-fixture-root" },
	});
	const base = `http://127.0.0.1:${server.port}`;
	const headers = { authorization: "Bearer capacity-fixture-root" };
	const traceId = "e".repeat(32);
	const send = (trace?: string) =>
		fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: {
				...headers,
				...(trace ? { traceparent: `00-${trace}-1111111111111111-01` } : {}),
			},
			body: JSON.stringify({
				model: "fixture",
				messages: [{ role: "user", content: "hello" }],
			}),
		});
	let first: Promise<Response> | undefined;
	let second: Promise<Response> | undefined;
	try {
		first = send();
		for (let i = 0; starts === 0 && i < 100; i++) await Bun.sleep(5);
		expect(starts).toBe(1);
		second = send(traceId);
		let state:
			| {
					held: { global: number };
					provider_pools: Record<string, Record<string, number>>;
			  }
			| undefined;
		for (let i = 0; i < 100; i++) {
			state = await (await fetch(`${base}/v1/admin/slots`, { headers })).json();
			if (state?.provider_pools?.account?.queued === 1) break;
			await Bun.sleep(5);
		}
		expect(state?.provider_pools.account).toMatchObject({
			active: 1,
			queued: 1,
			outstanding: 2,
		});
		expect(typeof state?.held.global).toBe("number");
		expect((await fetch(`${base}/v1/admin/slots`)).status).toBe(401);
		const metrics = await (
			await fetch(`${base}/v1/admin/metrics`, { headers })
		).text();
		expect(metrics).toContain('buckle_provider_pool_queued{pool="account"} 1');
		expect(metrics).toContain('buckle_provider_pool_active{pool="account"} 1');
		expect(await (await fetch(`${base}/metrics`)).text()).not.toContain(
			"buckle_provider_pool_",
		);
		release();
		for (const pending of [first, second]) {
			const response = await pending;
			expect(response.status).toBe(200);
			await response.text();
		}
		const settled = await (
			await fetch(`${base}/v1/admin/slots`, { headers })
		).json();
		expect(settled.provider_pools.account).toMatchObject({
			active: 0,
			queued: 0,
			outstanding: 0,
		});
		const trace = await (
			await fetch(`${base}/v1/admin/traces?trace_id=${traceId}`, { headers })
		).json();
		expect(trace.attempts[0].provider_pool).toBe("account");
		expect(trace.attempts[0].queue_wait_ms).toBeGreaterThan(0);
	} finally {
		release();
		await Promise.allSettled([first, second].filter(Boolean));
		server.stop(true);
		upstream.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
});
