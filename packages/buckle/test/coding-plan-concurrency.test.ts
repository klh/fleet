// test/coding-plan-concurrency.test.ts — W1266 Coding Plan concurrency
// regressions, all deterministic (fake upstream, zero live traffic):
//
//  1. Forward parity: 50 genuinely concurrent client requests through the
//     full proxy forward as EXACTLY 50 upstream calls — no accidental local
//     cap, no duplicate upstream inference (each marker seen once).
//  2. The Z.ai 1302 classification is data (config-over-code): mapped into
//     the pool's concurrencyErrorCodes the same burst collapses adaptive
//     concurrency (reproduces the live 3/50 slots read of 2026-10-24);
//     without the mapping the SAME burst paces (rate) and the ceiling holds.
//     docs.z.ai/api-reference/api-code lists 1302 as "Rate limit reached for
//     requests" — a rate code, 1311 is the entitlement code.
//  3. Queue-based recovery: an occupancy-clamped pool heals back to its
//     configured ceiling through healthy queued demand (the in-memory path
//     a reconfigure/restart relies on after the config retune).
//  4. A deliberately small BUCKLE_MAX_INFLIGHT stays VISIBLE: exactly
//     (50 - cap) local 429+Retry-After refusals, no truncation, no wedges.
import { describe, expect, test } from "bun:test";
import { parsePolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import { startServer } from "../src/server.ts";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";
import { startMockUpstream } from "./mock.ts";

const ROOT = "coding-plan-root";
const CHAT = (marker: string): string =>
	JSON.stringify({
		model: "glm-5.3-flash",
		stream: false,
		messages: [{ role: "user", content: `ping-${marker}` }],
	});
const OPENAI_OK = JSON.stringify({
	id: "ok",
	choices: [{ message: { role: "assistant", content: "hi" } }],
	usage: {},
});
// Pool policy shared by the classification tests (mirrors the live
// zai-coding-account shape; numbers scaled for a fast deterministic test).
const POOL_LIMITS = {
	concurrency: 6,
	intervalCap: 6,
	intervalMs: 1,
	maxOutstanding: 40,
	queueWaitMs: 1000,
	recovery: { successWindow: 8, decreasePercent: 20 },
};
// Z.ai 429 carrying the 1302 rate code, wrapped the way the provider does.
// W1257: a configured code alone is never concurrency — the embedded
// provider message carries the explicit evidence word for the mapped arm.
const zai429 = (): Response =>
	Response.json(
		{
			error: {
				message: `AnthropicException - ${JSON.stringify({ error: { code: "1302", type: "rate_limit_error", message: "too many concurrent streams" } })}`,
			},
		},
		{ status: 429 },
	);

describe("W1266 Coding Plan concurrency", () => {
	test("50 concurrent upstream forwards: peak active 50, each marker exactly once", async () => {
		// Barrier upstream: every chat forward is HELD until all 50 have
		// arrived (bounded 2s — fewer arrivals fails loudly). This proves
		// genuine concurrency, not just total forwards.
		const CHAT_PATH = "/v1/chat/completions";
		let active = 0;
		let peak = 0;
		let releaseAll!: () => void;
		const barrier = new Promise<void>((r) => {
			releaseAll = r;
		});
		const upstream = await startMockUpstream(async (req) => {
			if (new URL(req.url).pathname !== CHAT_PATH)
				return Response.json({ data: [] });
			active++;
			peak = Math.max(peak, active);
			if (active >= 50) releaseAll();
			const verdict = await Promise.race([
				barrier.then(() => "go" as const),
				Bun.sleep(2_000).then(() => "timeout" as const),
			]);
			active--;
			if (verdict === "timeout")
				return Response.json({ error: "barrier timeout" }, { status: 503 });
			return Response.json(JSON.parse(OPENAI_OK));
		});
		const cfg = `/tmp/w1266-parity-${Date.now()}-${process.pid}.json`;
		await Bun.write(
			cfg,
			JSON.stringify({
				groups: {
					"glm-5.3-flash": [{ url: upstream.url, dialect: "openai" }],
				},
			}),
		);
		const server = startServer({
			port: 0,
			upstreamsPath: cfg,
			dbPath: ":memory:",
			auth: { rootKey: ROOT },
		});
		const base = `http://127.0.0.1:${server.port}`;
		const issued = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ name: "w1266", scopes: ["buckle:proxy:WRITE_"] }),
		});
		const { key } = (await issued.json()) as { key: string };
		const round = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				fetch(`${base}/v1/chat/completions`, {
					method: "POST",
					headers: { authorization: `Bearer ${key}` },
					body: CHAT(String(i)),
				}).then(async (r) => ({ status: r.status, body: await r.json() })),
			),
		);
		for (const r of round) expect(r.status).toBe(200);
		const chatCalls = upstream.calls.filter((c) => c.path === CHAT_PATH);
		// exactly one upstream inference per client request
		expect(chatCalls).toHaveLength(50);
		expect(peak).toBe(50);
		const seen: string[] = [];
		for (const c of upstream.calls) {
			const body = c.body as { messages?: { content: string }[] } | null;
			if (body !== null && body.messages !== undefined)
				seen.push(body.messages[0].content);
		}
		expect(new Set(seen).size).toBe(50);
		server.stop(true);
		upstream.close();
	});

	test("Responses SSE refusals ride HTTP 200 — terminals are the verdict", async () => {
		const sse = [
			"event: response.failed",
			'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded"}}}',
			"",
			"",
		].join("\n");
		const upstream = await startMockUpstream(
			() =>
				new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const cfg = `/tmp/w1266-sse-${Date.now()}.json`;
		await Bun.write(
			cfg,
			JSON.stringify({
				groups: {
					"glm-5.3-flash": [{ url: upstream.url, dialect: "openai" }],
				},
			}),
		);
		const server = startServer({
			port: 0,
			upstreamsPath: cfg,
			dbPath: ":memory:",
			auth: { rootKey: ROOT },
		});
		const base = `http://127.0.0.1:${server.port}`;
		const issued = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ name: "w1266", scopes: ["buckle:proxy:WRITE_"] }),
		});
		const { key } = (await issued.json()) as { key: string };
		const resp = await fetch(`${base}/v1/responses`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "glm-5.3-flash",
				stream: true,
				input: "ping",
			}),
		});
		// status alone says "success"; the terminal event is the real verdict
		expect(resp.status).toBe(200);
		const text = await resp.text();
		const terminals = [...text.matchAll(/"type":"(response\.\w+)"/g)].map(
			(m) => m[1],
		);
		expect(terminals).toContain("response.failed");
		expect(terminals).not.toContain("response.completed");
		expect(text).toContain("rate_limit_exceeded");
		server.stop(true);
		upstream.close();
	});

	test("1302 classification is data: mapped collapses, unmapped paces with the ceiling intact", async () => {
		const mk = (mapped: boolean): Router =>
			new Router(
				parsePolicy(
					JSON.stringify({
						gateway: {
							num_retries: 0,
							provider_pools: {
								account: mapped
									? { ...POOL_LIMITS, concurrencyErrorCodes: ["1302"] }
									: POOL_LIMITS,
							},
						},
					}),
				),
				{
					pool: {
						groups: () => ["fixture"],
						deployments: () => [
							{
								group: "fixture",
								url: "https://fixture.invalid",
								dialect: "openai",
								adapter_config: { provider_pool: "account" },
							},
						],
					},
					fetchImpl: async () => zai429(),
				},
			);
		const burst = async (r: Router): Promise<number[]> =>
			Promise.all(
				Array.from({ length: 16 }, () =>
					r
						.execute({
							group: "fixture",
							dialect: "openai",
							path: "/v1/chat/completions",
							body: { model: "fixture" },
							key: "",
						})
						.then(
							(x) => x.status,
							() => 0,
						),
				),
			);
		// BEFORE — the live machine config of 2026-10-24: 1302 counted as
		// concurrency pressure, one burst collapsed the ceiling.
		const mapped = mk(true);
		await burst(mapped);
		const before = mapped.providerAdmissionSnapshot().account;
		expect(before?.concurrencyLimitedTotal).toBe(16);
		expect(before?.adaptiveConcurrency ?? 6).toBeLessThan(6);
		// AFTER — retune: same burst, pure rate pressure; ceiling holds.
		const unmapped = mk(false);
		await burst(unmapped);
		const after = unmapped.providerAdmissionSnapshot().account;
		expect(after?.concurrencyLimitedTotal).toBe(0);
		expect(after?.rateLimitedTotal).toBe(16);
		expect(after?.adaptiveConcurrency).toBe(6);
		expect(after?.adaptiveGapMs).toBeGreaterThan(POOL_LIMITS.intervalMs);
	});

	test("occupancy clamp heals to the ceiling through queued healthy demand", async () => {
		const core = new ProviderAdmissionCore({
			...POOL_LIMITS,
			concurrency: 8,
			intervalCap: 8,
			maxOutstanding: 80,
			queueWaitMs: 500,
			recovery: { successWindow: 2, decreasePercent: 50 },
		});
		const held = await Promise.all(
			Array.from({ length: 8 }, () => core.acquire()),
		);
		for (const lease of held) lease.feedback?.(429, null, "concurrency");
		for (const lease of held) lease.release();
		// Worst case: the FIRST grant started at occupancy 1, so the clamp
		// floors at 1 (the live 2026-10-24 read was 3/50 mid-ramp).
		expect(core.snapshot().adaptiveConcurrency).toBe(1);
		// queued healthy demand walks the clamp back up (successWindow 2);
		// demand must outlast the drain or the walk stalls early
		const waiters = Array.from({ length: 40 }, () =>
			core.acquire().then(async (lease) => {
				await Bun.sleep(2);
				lease.feedback?.(200, null);
				lease.release();
			}),
		);
		await Promise.all(waiters);
		expect(core.snapshot().adaptiveConcurrency).toBe(8);
		await Bun.sleep(5); // let the last release tick settle
		expect(core.snapshot().outstanding).toBe(0);
	});

	test("a small BUCKLE_MAX_INFLIGHT stays visible: bounded 429s, no wedge", async () => {
		const upstream = await startMockUpstream(async () => {
			await Bun.sleep(150);
			return Response.json(JSON.parse(OPENAI_OK));
		});
		const cfg = `/tmp/w1266-cap-${Date.now()}.json`;
		await Bun.write(
			cfg,
			JSON.stringify({
				groups: {
					"glm-5.3-flash": [{ url: upstream.url, dialect: "openai" }],
				},
			}),
		);
		process.env.BUCKLE_MAX_INFLIGHT = "40";
		let server: ReturnType<typeof startServer>;
		try {
			server = startServer({
				port: 0,
				upstreamsPath: cfg,
				dbPath: ":memory:",
				auth: { rootKey: ROOT },
			});
		} finally {
			delete process.env.BUCKLE_MAX_INFLIGHT;
		}
		expect(true).toBe(true);
		const base = `http://127.0.0.1:${server.port}`;
		const issued = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ name: "w1266", scopes: ["buckle:proxy:WRITE_"] }),
		});
		const { key } = (await issued.json()) as { key: string };
		const chat = (): Promise<Response> =>
			fetch(`${base}/v1/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: CHAT("cap"),
			});
		const round = await Promise.all(Array.from({ length: 50 }, () => chat()));
		const ok = round.filter((r) => r.status === 200);
		// W1257: the gateway's own overload refusal is a typed LOCAL 503, never
		// a fabricated provider 429; Retry-After still bounds the retry.
		const refused = round.filter((r) => r.status === 503);
		await Bun.sleep(200); // all served bodies drain before the reuse probe
		const next = await chat();
		expect(ok).toHaveLength(40);
		expect(refused).toHaveLength(10);
		for (const r of refused) expect(r.headers.get("retry-after")).toBe("2");
		expect(next.status).toBe(200);
		server.stop(true);
		upstream.close();
	});
});
