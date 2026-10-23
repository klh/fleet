// test/router-provider-admission.test.ts — W1078 provider-account admission
// through the real Router seam (mocked fetchImpl, in-process): account pools
// pace starts across aliases, bound streams hold their lease to EOF/cancel/
// error, and a local queue refusal never masquerades as an upstream verdict.
import { describe, expect, test } from "bun:test";
import { errorResponse } from "../src/handlers.ts";
import { parsePolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";

const POLICY = parsePolicy(`
gateway:
  num_retries: 0
  allowed_fails: 99
  cooldown_time: 30
  first_byte_budget_s: 30
  request_timeout_s: 5
  provider_pools:
    zai-main:
      concurrency: 1
      intervalCap: 100
      intervalMs: 50
      maxOutstanding: 3
      queueWaitMs: 1000
      recovery:
        successWindow: 8
        decreasePercent: 5
`);

function poolOf(deps: Deployment[]): UpstreamPool {
	const groups = new Map<string, Deployment[]>();
	for (const dep of deps)
		groups.set(dep.group, [...(groups.get(dep.group) ?? []), dep]);
	return {
		groups: () => [...groups.keys()],
		deployments: (g) => groups.get(g) ?? [],
	};
}

const dep = (url: string, group: string, poolId?: string): Deployment => ({
	group,
	url,
	dialect: "openai",
	...(poolId === undefined
		? {}
		: { adapter_config: { provider_pool: poolId } }),
});

interface Held {
	response: Response;
	end: () => void;
	fail: (e: unknown) => void;
}

/** Headers now, body settles only when end()/fail() fires. */
function held(): Held {
	let end!: () => void;
	let fail!: (e: unknown) => void;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				end = () => c.close();
				fail = (e) => c.error(e);
			},
		}),
	);
	return { response, end, fail };
}

const req = (group: string, signal?: AbortSignal) => ({
	group,
	dialect: "openai" as const,
	path: "/v1/chat/completions",
	body: { model: group } as Record<string, unknown>,
	key: "",
	...(signal === undefined ? {} : { signal }),
});

/** Poll until `when` holds or the budget lapses (false = timed out). */
async function waitFor(when: () => boolean, budgetMs = 300): Promise<boolean> {
	const until = Date.now() + budgetMs;
	while (Date.now() < until) {
		if (when()) return true;
		await Bun.sleep(5);
	}
	return when();
}

describe("provider-account admission", () => {
	test("configured missing pool refuses startup", () => {
		expect(
			() =>
				new Router(POLICY, {
					pool: poolOf([dep("http://a", "m1", "ghost")]),
					sleepMs: async () => {},
				}),
		).toThrow(/no matching gateway.provider_pools/);
	});

	test("two aliases sharing a pool cannot exceed its rolling start budget", async () => {
		// concurrency:2, intervalCap:2/60ms: both slots start at ~t0 (the
		// window holds exactly 2 tokens). Releasing one slot lets req3 ENTER
		// the queue but its start still waits for the next window token —
		// the shared budget, not free concurrency, then gates start 3.
		const pace = parsePolicy(`gateway:
  num_retries: 0
  allowed_fails: 99
  cooldown_time: 30
  first_byte_budget_s: 30
  request_timeout_s: 5
  provider_pools:
    zai-main:
      concurrency: 2
      intervalCap: 2
      intervalMs: 60
      maxOutstanding: 4
      queueWaitMs: 1000
      recovery:
        successWindow: 8
        decreasePercent: 5
`);
		const executed: number[] = [];
		let end1!: () => void;
		const router = new Router(pace, {
			pool: poolOf([
				dep("http://a", "m1", "zai-main"),
				dep("http://b", "m2", "zai-main"),
			]),
			sleepMs: async () => {},
			fetchImpl: async () => {
				executed.push(Date.now());
				if (executed.length === 1) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(c) {
								end1 = () => c.close();
							},
						}),
					);
				}
				return Response.json({ ok: true });
			},
		});
		const w1 = router.execute(req("m1"));
		const w2 = router.execute(req("m2"));
		await Bun.sleep(30); // both slots start; end1 assigned
		end1(); // frees a concurrency slot; the window token is still spent
		const r3 = await router.execute(req("m1"));
		expect(r3.kind).toBe("upstream");
		await w1;
		await w2;
		// start3 waits for the next window token: >= intervalMs after t1
		expect(executed[2] - executed[0]).toBeGreaterThanOrEqual(45);
	});

	test("an unbound deployment keeps its full fetch budget", async () => {
		const timeouts: number[] = [];
		const router = new Router(POLICY, {
			pool: poolOf([dep("http://a", "m1")]),
			sleepMs: async () => {},
			fetchImpl: async (_d, _r, timeoutMs) => {
				timeouts.push(timeoutMs);
				return Response.json({ ok: true });
			},
		});
		const r = await router.execute(req("m1"));
		expect(r.kind).toBe("upstream");
		expect(timeouts).toEqual([5000]);
	});

	test("queued abort never calls fetch", async () => {
		const first = held();
		let fetches = 0;
		const router = new Router(POLICY, {
			pool: poolOf([dep("http://a", "m1", "zai-main")]),
			sleepMs: async () => {},
			fetchImpl: async () => {
				fetches++;
				return first.response;
			},
		});
		const w1 = router.execute(req("m1"));
		await Bun.sleep(10); // slot held by the hanging body
		const abort = new AbortController();
		const w2 = router.execute(req("m1", abort.signal));
		await Bun.sleep(10); // queued behind the held slot
		abort.abort();
		// W1124.42.1: the aborted walk carries its real attempt count — the
		// queued attempt had already consumed its ordinal (and banks its
		// downstream_cancel receipt), so the count is 1, never zeroed.
		expect(await w2).toEqual({ kind: "aborted", attempts: 1 });
		expect(fetches).toBe(1);
		await w1;
		first.end();
	});

	test("headers alone retain concurrency until the body settles", async () => {
		const first = held();
		let fetches = 0;
		const router = new Router(POLICY, {
			pool: poolOf([dep("http://a", "m1", "zai-main")]),
			sleepMs: async () => {},
			fetchImpl: async () => {
				fetches++;
				return first.response;
			},
		});
		const w1 = router.execute(req("m1"));
		await Bun.sleep(10); // headers delivered, body hanging
		const w2 = router.execute(req("m1"));
		await Bun.sleep(30); // still hanging: no second fetch may happen
		expect(fetches).toBe(1);
		const kind2 = w2.then((r) => r.kind);
		first.end(); // EOF releases the lease; the queued start fires
		expect(await kind2).toBe("upstream");
		await w1;
	});

	test("body EOF, cancel and error all release the lease", async () => {
		for (const settle of ["eof", "cancel", "error"] as const) {
			const first = held();
			let fetches = 0;
			const router = new Router(POLICY, {
				pool: poolOf([dep("http://a", "m1", "zai-main")]),
				sleepMs: async () => {},
				fetchImpl: async () => {
					fetches++;
					return first.response;
				},
			});
			const w1 = router.execute(req("m1"));
			await Bun.sleep(10);
			const r1 = await w1;
			expect(r1.kind).toBe("upstream");
			if (r1.kind !== "upstream") return;
			// the bound body is the client-side handle on the lease
			if (settle === "eof") {
				first.end();
				await r1.response.text();
			} else if (settle === "cancel") {
				await r1.response.body?.cancel();
			} else {
				first.fail(new Error("synthetic upstream failure"));
				await expect(r1.response.text()).rejects.toThrow("synthetic");
			}
			const w2 = router.execute(req("m1"));
			const settled = await waitFor(() => fetches === 2, 250);
			expect(settled).toBe(true);
			expect(fetches).toBe(2);
			const r2 = await w2;
			expect(r2.kind).toBe("upstream");
		}
	});

	test("a failed fetch releases the lease", async () => {
		let fetches = 0;
		const router = new Router(POLICY, {
			pool: poolOf([dep("http://a", "m1", "zai-main")]),
			sleepMs: async () => {},
			fetchImpl: async () => {
				fetches++;
				if (fetches === 1) throw new Error("connect ECONNREFUSED");
				return Response.json({ ok: true });
			},
		});
		const r1 = await router.execute(req("m1"));
		expect(r1.kind).toBe("exhausted");
		const r2 = await router.execute(req("m1"));
		// a leaked lease would refuse admission instead of fetching again
		expect(r2.kind).toBe("upstream");
		expect(fetches).toBe(2);
	});

	test("a provider 429 is never a local admission refusal", async () => {
		let fetches = 0;
		const policy = {
			...POLICY,
			provider_pools: Object.fromEntries(
				Object.entries(POLICY.provider_pools ?? {}).map(([id, value]) => [
					id,
					{ ...value, queueWaitMs: 4000 },
				]),
			),
		};
		const router = new Router(policy, {
			pool: poolOf([dep("http://a", "m1", "zai-main")]),
			sleepMs: async () => {},
			fetchImpl: async () => {
				fetches++;
				return Response.json(
					{ error: { message: "rate limited" } },
					{ status: 429, headers: { "retry-after": "3" } },
				);
			},
		});
		const r1 = await router.execute(req("m1"));
		expect(r1.kind).toBe("client-error");
		if (r1.kind === "client-error") {
			expect(r1.failureKind).toBe("rate_limited");
			expect(r1.response.status).toBe(429);
		}
		const r2 = await router.execute(req("m1"));
		// The error body releases the lease, but the shared pool must still
		// honor the provider's Retry-After before starting another request.
		expect(fetches).toBe(2);
		expect(r2.kind).toBe("client-error");
	});

	test("queue wait consumes the walk budget without reducing the independent network cap", async () => {
		const first = held();
		const timeouts: number[] = [];
		let fetches = 0;
		let now = 0;
		const router = new Router(POLICY, {
			now: () => now,
			pool: poolOf([dep("http://a", "m1", "zai-main")]),
			sleepMs: async () => {},
			fetchImpl: async (_d, _r, timeoutMs) => {
				fetches++;
				timeouts.push(timeoutMs);
				return fetches === 1 ? first.response : Response.json({ ok: true });
			},
		});
		const w1 = await router.execute(req("m1"));
		now = 10; // first body holds the slot
		const w2 = router.execute(req("m1")); // queues
		await Bun.sleep(10); // dwell accrues while queued
		now = 35; // deterministic 25ms admission dwell
		first.end(); // release: the queued start fires with deducted budget
		const r2 = await w2;
		expect(r2.kind).toBe("upstream");
		if (w1.kind === "upstream") await w1.response.text();
		expect(timeouts[0]).toBe(5000);
		expect(timeouts[1]).toBe(5000);
	});

	test("malformed pool policy refuses to parse", () => {
		expect(() =>
			parsePolicy(`gateway:
  provider_pools:
    zai-main:
      concurrency: 0
      intervalCap: 1
      intervalMs: 1
      maxOutstanding: 1
      queueWaitMs: 1
      recovery:
        successWindow: 8
        decreasePercent: 5
`),
		).toThrow(/explicit bounded recovery/);
	});

	test("bound successes carry pool canary metadata; unbound stay clean", async () => {
		const router = new Router(POLICY, {
			pool: poolOf([dep("http://a", "m1", "zai-main"), dep("http://b", "m2")]),
			sleepMs: async () => {},
			fetchImpl: async () => Response.json({ ok: true }),
		});
		const bound = await router.execute(req("m1"));
		const unbound = await router.execute(req("m2"));
		expect(bound.kind).toBe("upstream");
		expect(unbound.kind).toBe("upstream");
		if (bound.kind !== "upstream" || unbound.kind !== "upstream") return;
		expect(bound.response.headers.get("x-klh-provider-pool")).toBe("zai-main");
		const wait = bound.response.headers.get("x-klh-provider-queue-wait-ms");
		expect(wait).not.toBeNull();
		expect(Number(wait)).toBeGreaterThanOrEqual(0);
		expect(unbound.response.headers.get("x-klh-provider-pool")).toBeNull();
		expect(
			unbound.response.headers.get("x-klh-provider-queue-wait-ms"),
		).toBeNull();
	});
});

test("same-walk account skip preserves shared backoff for the next request", async () => {
	const calls: string[] = [];
	const router = new Router(
		{ ...POLICY, fallbacks: { primary: ["alias", "local"] } },
		{
			pool: poolOf([
				dep("https://primary.example.invalid", "primary", "zai-main"),
				dep("https://alias.example.invalid", "alias", "zai-main"),
				dep("https://local.example.invalid", "local"),
			]),
			fetchImpl: async (deployment) => {
				calls.push(deployment.group);
				return deployment.group === "local"
					? new Response("ok")
					: new Response("limited", {
							status: 429,
							headers: { "retry-after": "60" },
						});
			},
		},
	);
	const first = await router.execute(req("primary"));
	expect(first.kind).toBe("upstream");
	expect(calls).toEqual(["primary", "local"]);
	expect(
		router.providerAdmissionSnapshot()["zai-main"]?.notBeforeMs,
	).toBeGreaterThan(Date.now() + 50000);
	const controller = new AbortController();
	const second = router.execute(req("alias", controller.signal));
	await Bun.sleep(25);
	expect(calls).toEqual(["primary", "local"]);
	controller.abort();
	expect((await second).kind).toBe("aborted");
});

test("queue expiry is local evidence and skips account aliases before an independent fallback", async () => {
	const receipts: import("../../telemetry/src/http-trace.ts").HopReceipt[] = [];
	const calls: string[] = [];
	const blocker = held();
	const router = new Router(
		{
			...POLICY,
			request_timeout_s: 0.025,
			first_byte_budget_s: 0.2,
			provider_pools: Object.fromEntries(
				Object.entries(POLICY.provider_pools ?? {}).map(([id, policy]) => [
					id,
					{ ...policy, queueWaitMs: 25 },
				]),
			),
			fallbacks: { primary: ["alias", "local"] },
		},
		{
			pool: poolOf([
				dep("https://blocker.example.invalid", "blocker", "zai-main"),
				dep("https://primary.example.invalid", "primary", "zai-main"),
				dep("https://alias.example.invalid", "alias", "zai-main"),
				dep("https://local.example.invalid", "local"),
			]),
			metrics: {
				fallback() {},
				cooldown() {},
				refused() {},
				attempt(receipt) {
					receipts.push(receipt);
				},
			},
			fetchImpl: async (deployment) => {
				calls.push(deployment.group);
				return deployment.group === "blocker"
					? blocker.response
					: new Response("ok");
			},
		},
	);
	const first = await router.execute(req("blocker"));
	try {
		const second = await router.execute(req("primary"));
		expect(second.kind).toBe("upstream");
		expect(calls).toEqual(["blocker", "local"]);
		expect(receipts[1]).toMatchObject({
			status: 503,
			refusal: "local_admission",
			refusalOrigin: "local-admission",
			providerPool: "zai-main",
		});
		expect(receipts[1]?.queueWaitMs).toBeGreaterThanOrEqual(20);
	} finally {
		blocker.end();
		if (first.kind === "upstream") await first.response.text();
	}
});

test("a queued grant followed by fetch timeout retains dwell and skips account requeue", async () => {
	const receipts: import("../../telemetry/src/http-trace.ts").HopReceipt[] = [];
	const calls: string[] = [];
	const blocker = held();
	let fetchBudget = 0;
	const router = new Router(
		{
			...POLICY,
			request_timeout_s: 0.04,
			first_byte_budget_s: 0.2,
			fallbacks: { primary: ["alias", "local"] },
		},
		{
			pool: poolOf([
				dep("https://blocker.example.invalid", "blocker", "zai-main"),
				dep("https://primary.example.invalid", "primary", "zai-main"),
				dep("https://alias.example.invalid", "alias", "zai-main"),
				dep("https://local.example.invalid", "local"),
			]),
			metrics: {
				fallback() {},
				cooldown() {},
				refused() {},
				attempt(receipt) {
					receipts.push(receipt);
				},
			},
			fetchImpl: async (deployment, _request, budget) => {
				calls.push(deployment.group);
				if (deployment.group === "blocker") return blocker.response;
				if (deployment.group === "local") return new Response("ok");
				fetchBudget = budget;
				await Bun.sleep(budget);
				throw new DOMException("fixture header timeout", "TimeoutError");
			},
		},
	);
	const first = await router.execute(req("blocker"));
	const second = router.execute(req("primary"));
	await Bun.sleep(25);
	blocker.end();
	if (first.kind === "upstream") await first.response.text();
	expect((await second).kind).toBe("upstream");
	expect(calls).toEqual(["blocker", "primary", "local"]);
	expect(fetchBudget).toBeLessThan(65);
	expect(receipts[1]?.queueWaitMs).toBeGreaterThanOrEqual(20);
	expect(receipts[1]).toMatchObject({
		refusal: "network",
		refusalOrigin: "network",
		providerPool: "zai-main",
	});
});

test("admission may outlast the network cap while retaining that cap inside the walk deadline", async () => {
	const blocker = held();
	const budgets: number[] = [];
	const router = new Router(
		{ ...POLICY, request_timeout_s: 0.02, first_byte_budget_s: 0.2 },
		{
			pool: poolOf([dep("https://fixture.invalid", "m", "zai-main")]),
			fetchImpl: async (_d, _r, budget) => {
				budgets.push(budget);
				return budgets.length === 1 ? blocker.response : new Response("ok");
			},
		},
	);
	const first = await router.execute(req("m"));
	const second = router.execute(req("m"));
	await Bun.sleep(50); // longer than the 20ms network cap, within the 200ms walk
	blocker.end();
	if (first.kind === "upstream") await first.response.text();
	expect((await second).kind).toBe("upstream");
	expect(budgets).toEqual([20, 20]);
});

test("a held admission cannot outlive the remaining walk deadline", async () => {
	const blocker = held();
	let calls = 0;
	const router = new Router(
		{ ...POLICY, request_timeout_s: 0.02, first_byte_budget_s: 0.05 },
		{
			pool: poolOf([dep("https://fixture.invalid", "m", "zai-main")]),
			fetchImpl: async () => {
				calls++;
				return blocker.response;
			},
		},
	);
	const first = await router.execute(req("m"));
	const started = performance.now();
	const second = await router.execute(req("m"));
	expect(performance.now() - started).toBeLessThan(120);
	expect(second.kind).toBe("exhausted");
	expect(calls).toBe(1);
	blocker.end();
	if (first.kind === "upstream") await first.response.text();
});

test("a lease granted after walk expiry is released without fetching", async () => {
	const blocker = held();
	let now = 0;
	let calls = 0;
	const router = new Router(
		{ ...POLICY, request_timeout_s: 0.02, first_byte_budget_s: 0.05 },
		{
			now: () => now,
			pool: poolOf([dep("https://fixture.invalid", "m", "zai-main")]),
			fetchImpl: async () => {
				calls++;
				return blocker.response;
			},
		},
	);
	const first = await router.execute(req("m"));
	const second = router.execute(req("m"));
	await Bun.sleep(5);
	now = 60;
	blocker.end();
	if (first.kind === "upstream") await first.response.text();
	expect((await second).kind).toBe("exhausted");
	expect(calls).toBe(1);
	await Bun.sleep(5);
	expect(router.providerAdmissionSnapshot()["zai-main"]?.outstanding).toBe(0);
});

test("nested peer network refusal skips shared account aliases within the original walk", async () => {
	const calls: string[] = [];
	const blocker = held();
	const peer = new Router(
		{ ...POLICY, num_retries: 0, request_timeout_s: 0.035 },
		{
			pool: poolOf([dep("https://backend.example.invalid", "primary")]),
			fetchImpl: async (_dep, _req, budget) => {
				await Bun.sleep(budget);
				throw new DOMException(
					"fixture peer first byte timeout",
					"TimeoutError",
				);
			},
		},
	);
	const server = Bun.serve({
		port: 0,
		fetch: async () => {
			const result = await peer.execute(req("primary"));
			expect(result.kind).toBe("exhausted");
			if (result.kind !== "exhausted") throw new Error("peer did not fail");
			const response = errorResponse(result.status, result.error);
			response.headers.set(
				"x-klh-refusal",
				result.lastFailure?.kind ?? "unknown",
			);
			return response;
		},
	});
	const receipts: import("../../telemetry/src/http-trace.ts").HopReceipt[] = [];
	const router = new Router(
		{
			...POLICY,
			num_retries: 1,
			first_byte_budget_s: 0.25,
			request_timeout_s: 0.1,
			fallbacks: { primary: ["alias", "local"] },
		},
		{
			pool: poolOf([
				dep("https://blocker.example.invalid", "blocker", "zai-main"),
				dep(server.url.href, "primary", "zai-main"),
				dep("https://alias.example.invalid", "alias", "zai-main"),
				dep("https://local.example.invalid", "local"),
			]),
			sleepMs: async () => {},
			metrics: {
				fallback() {},
				cooldown() {},
				refused() {},
				attempt(receipt) {
					receipts.push(receipt);
				},
			},
			fetchImpl: async (deployment, _req, budget) => {
				calls.push(deployment.group);
				if (deployment.group === "blocker") return blocker.response;
				if (deployment.group === "local") return new Response("ok");
				return fetch(deployment.url, { signal: AbortSignal.timeout(budget) });
			},
		},
	);
	try {
		const first = await router.execute(req("blocker"));
		const start = Date.now();
		const pending = router.execute(req("primary"));
		await Bun.sleep(100);
		blocker.end();
		if (first.kind === "upstream") await first.response.text();
		const result = await pending;
		expect(result.kind).toBe("upstream");
		expect(calls).toEqual(["blocker", "primary", "local"]);
		expect(Date.now() - start).toBeLessThan(250);
		expect(receipts[1]).toMatchObject({
			status: 502,
			refusal: "network",
			upstreamRefusalCode: "network",
			providerPool: "zai-main",
		});
		expect(receipts[1]?.queueWaitMs).toBeGreaterThanOrEqual(90);
		if (result.kind === "upstream") await result.response.text();
	} finally {
		server.stop(true);
	}
});
