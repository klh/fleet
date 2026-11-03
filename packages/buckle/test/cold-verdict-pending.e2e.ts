// test/cold-verdict-pending.e2e.ts — W2544: the pending-verdict contract.
// A rider whose bounded wait on an in-flight verdict expires gets a TYPED
// local pending outcome — never a cooldown claim, never a fabricated
// provider refusal — while real rate/quota cooldowns stay cold answers.
// Every test counts real upstream knocks (fetchImpl calls) so the
// anti-stampede coalescing the owner asked to preserve is pinned too.
import { expect, test } from "@playwright/test";
import { ColdMarks } from "../src/cold-marks.ts";
import { parsePolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";

test.describe("@api", () => {
	const POLICY = parsePolicy(`{
		"gateway": {
			"num_retries": 0,
			"allowed_fails": 99,
			"cooldown_time": 30,
			"first_byte_budget_s": 30,
			"request_timeout_s": 5,
			"provider_pools": {
				"zai-main": {
					"concurrency": 8,
					"intervalCap": 100,
					"intervalMs": 50,
					"maxOutstanding": 16,
					"queueWaitMs": 1000,
					"recovery": { "successWindow": 8, "decreasePercent": 5 }
				}
			}
		}
	}`);

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

	const req = (group: string, signal?: AbortSignal) => ({
		group,
		dialect: "openai" as const,
		path: "/v1/chat/completions",
		body: { model: group } as Record<string, unknown>,
		key: "",
		...(signal === undefined ? {} : { signal }),
	});

	/** The knock itself hangs until settle() — the verdict gate stays
	 *  genuinely pending (headers alone would settle it as a success). */
	function held() {
		let settle!: (r: Response) => void;
		const response = new Promise<Response>((r) => {
			settle = r;
		});
		return { response, settle };
	}

	test.describe("expired ride on a still-pending verdict (no 429 ever seen)", () => {
		test("a slow healthy first response outlives the follower's ride: typed pending 503, not a cooldown", async () => {
			const knock = held();
			let knocks = 0;
			// walk budget 3s > the 1500ms ride bound: the ride expires while
			// real budget remains — the gate-pending shape, not ride-deadline.
			// The dep carries NO provider pool: pooled rows fall through to
			// admission instead (W2585 on main) — this pins the un-pooled
			// account shape, where no bound exists and the rider must be
			// answered locally.
			const router = new Router(
				{ ...POLICY, first_byte_budget_s: 3, request_timeout_s: 5 },
				{
					pool: poolOf([dep("http://a", "m1")]),
					sleepMs: async () => {},
					fetchImpl: async () => {
						knocks++;
						// the leader's knock hangs on the shared promise; every
						// later knock answers a FRESH body (single-consumption)
						return knocks === 1 ? knock.response : Response.json({ ok: true });
					},
				},
			);
			const leader = router.execute(req("m1"));
			await Bun.sleep(10); // leader's knock in flight, placeholder stamped
			const rider = await router.execute(req("m1"));
			// the typed pending outcome: 503, truthful words, bounded advice —
			// NEVER the pre-W2544 "cooling down (shared cold mark)" lie.
			expect(rider.kind).toBe("exhausted");
			if (rider.kind !== "exhausted") return;
			expect(rider.status).toBe(503);
			expect(rider.error).toContain("pending");
			expect(rider.error).not.toContain("cooling down");
			expect(rider.error).not.toContain("cold mark");
			// bounded retry advice (probe_stale_s horizon), never weeks
			expect(rider.retryAfterS).not.toBeNull();
			expect(rider.retryAfterS as number).toBeLessThanOrEqual(30);
			// exactly ONE real knock — the rider never reached the wire
			expect(knocks).toBe(1);
			// the placeholder is not a provider limit in the snapshot
			const rows = router.cooldowns.cold.snapshot();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ state: "pending", reason: "none" });
			// the slow healthy answer still lands for the leader: success
			// retires the placeholder — no cold residue for the NEXT caller.
			knock.settle(Response.json({ ok: true }));
			expect((await leader).kind).toBe("upstream");
			expect(router.cooldowns.cold.snapshot()).toEqual([]);
			const after = await router.execute(req("m1"));
			expect(after.kind).toBe("upstream");
			expect(knocks).toBe(2);
		});

		test("a ride that ate the whole walk budget reports the walk deadline, not a cooldown", async () => {
			const knock = held();
			let knocks = 0;
			// walk budget 30ms < the 1500ms ride bound: the ride expires
			// exactly at the deadline — the ride-deadline shape.
			const router = new Router(
				{ ...POLICY, first_byte_budget_s: 0.03, request_timeout_s: 5 },
				{
					pool: poolOf([dep("http://a", "m1", "zai-main")]),
					sleepMs: async () => {},
					fetchImpl: async () => {
						knocks++;
						return knock.response;
					},
				},
			);
			const leader = router.execute(req("m1"));
			await Bun.sleep(5);
			const rider = await router.execute(req("m1"));
			expect(rider.kind).toBe("exhausted");
			if (rider.kind !== "exhausted") return;
			// the ride ate the ENTIRE walk budget: the walk's own deadline
			// answer (504) outranks the refusal's 503 — honest, and still
			// never a cooldown claim. The typed verdict_pending receipt is
			// banked (refusal origin local-admission).
			expect(rider.status).toBe(504);
			expect(rider.error).toContain("walk deadline");
			expect(rider.error).not.toContain("cooling down");
			expect(knocks).toBe(1);
			knock.settle(Response.json({ ok: true }));
			expect((await leader).kind).toBe("upstream");
		});

		test("an aborted rider never knocks and never gets a fabricated answer", async () => {
			const knock = held();
			let knocks = 0;
			const router = new Router(
				{ ...POLICY, first_byte_budget_s: 3, request_timeout_s: 5 },
				{
					pool: poolOf([dep("http://a", "m1", "zai-main")]),
					sleepMs: async () => {},
					fetchImpl: async () => {
						knocks++;
						return knock.response;
					},
				},
			);
			const leader = router.execute(req("m1"));
			await Bun.sleep(10);
			const abort = new AbortController();
			const rider = router.execute(req("m1", abort.signal));
			await Bun.sleep(10); // rider is riding the in-flight verdict
			abort.abort();
			expect((await rider).kind).toBe("aborted");
			expect(knocks).toBe(1);
			knock.settle(Response.json({ ok: true }));
			expect((await leader).kind).toBe("upstream");
		});
	});

	test.describe("genuine cooldown stays a cold answer (contrast)", () => {
		test("a real provider 429 verdict answers riders with the cold mark, not pending", async () => {
			const knock = held();
			let knocks = 0;
			const router = new Router(POLICY, {
				pool: poolOf([dep("http://a", "m1", "zai-main")]),
				rng: () => 0, // pinned: the cold window is the provider's 7s
				sleepMs: async () => {},
				fetchImpl: async () => {
					knocks++;
					return knock.response;
				},
			});
			const leader = router.execute(req("m1"));
			await Bun.sleep(10);
			const rider = router.execute(req("m1"));
			await Bun.sleep(10);
			// the provider's own 429 + Retry-After IS the verdict
			knock.settle(
				new Response("rate limited", {
					status: 429,
					headers: { "retry-after": "7" },
				}),
			);
			expect((await leader).kind).toBe("client-error");
			const r = await rider;
			expect(r.kind).toBe("exhausted");
			if (r.kind !== "exhausted") return;
			// the settled-refused rider gets the LOCAL cold answer (503 +
			// the honest window) — the account colded the instant the verdict
			// landed; never "pending", never a fabricated provider body.
			expect(r.status).toBe(503);
			expect(r.retryAfterS).toBe(7);
			expect(r.error).toContain("cooling down");
			expect(knocks).toBe(1);
			// and the NEXT caller gets the 429 cold-mark hold with the
			// provider's window — the pre-W2544 local path, preserved.
			const later = await router.execute(req("m1"));
			expect(later.kind).toBe("exhausted");
			if (later.kind !== "exhausted") return;
			expect(later.status).toBe(429);
			expect(later.retryAfterS).toBe(7);
			expect(later.error).toContain("cold mark");
			expect(knocks).toBe(1);
			const rows = router.cooldowns.cold.snapshot();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ state: "cold", reason: "rate" });
		});
	});

	test.describe("provider-pool alias fencing", () => {
		test("a pending verdict does not fence the fallback rung", async () => {
			const knock = held();
			const calls: string[] = [];
			// UNPOOLED primary: a pooled lapsed ride falls through to
			// admission instead (W2585 on main) and is served by its own
			// knock — the gate-pending refusal this pins is the un-pooled
			// account shape. The walk advances to the fallback rung: a
			// pending verdict is not account knowledge and never fences.
			const router = new Router(
				{
					...POLICY,
					first_byte_budget_s: 3,
					fallbacks: { primary: ["local"] },
				},
				{
					pool: poolOf([
						dep("https://primary.example.invalid", "primary"),
						dep("https://local.example.invalid", "local"),
					]),
					sleepMs: async () => {},
					fetchImpl: async (d) => {
						calls.push(d.group);
						return d.group === "primary" ? knock.response : new Response("ok");
					},
				},
			);
			const leader = router.execute(req("primary"));
			await Bun.sleep(10);
			const r = await router.execute(req("primary"));
			// pending on the shared gate is NOT account knowledge: the walk
			// advances to the fallback rung and serves there.
			expect(r.kind).toBe("upstream");
			expect(calls).toEqual(["primary", "local"]);
			knock.settle(Response.json({ ok: true }));
			expect((await leader).kind).toBe("upstream");
		});

		test("a real cold verdict still fences the account's aliases within the walk", async () => {
			let knocks = 0;
			const router = new Router(
				{
					...POLICY,
					request_timeout_s: 5,
					fallbacks: { primary: ["alias", "local"] },
				},
				{
					pool: poolOf([
						dep("https://primary.example.invalid", "primary", "zai-main"),
						dep("https://alias.example.invalid", "alias", "zai-main"),
						dep("https://local.example.invalid", "local"),
					]),
					sleepMs: async () => {},
					fetchImpl: async (d) => {
						knocks++;
						return d.group === "local"
							? new Response("ok")
							: new Response("limited", {
									status: 429,
									headers: { "retry-after": "9" },
								});
					},
				},
			);
			const r = await router.execute(req("primary"));
			expect(r.kind).toBe("upstream");
			// primary knocked (429 → cold), alias FENCED (same account, no
			// knock), local served — the W1078 account skip, unchanged.
			expect(knocks).toBe(2);
		});
	});

	test.describe("repeated bursts ride the one in-flight knock", () => {
		test("concurrent followers with no prior 429 add ZERO knocks while the verdict is pending", async () => {
			const knock = held();
			let knocks = 0;
			// un-pooled account (see the first test): pooled followers fall
			// through to admission per W2585 — the coalescing window this
			// pins is the no-pool gate-pending hold.
			const router = new Router(
				{ ...POLICY, first_byte_budget_s: 3, request_timeout_s: 5 },
				{
					pool: poolOf([dep("http://a", "m1")]),
					sleepMs: async () => {},
					fetchImpl: async () => {
						knocks++;
						// the leader's knock hangs on the shared promise; every
						// later knock answers a FRESH body (single-consumption)
						return knocks === 1 ? knock.response : Response.json({ ok: true });
					},
				},
			);
			const leader = router.execute(req("m1"));
			await Bun.sleep(10); // placeholder stamped, knock in flight
			const followers = [
				router.execute(req("m1")),
				router.execute(req("m1")),
				router.execute(req("m1")),
			];
			await Bun.sleep(30); // all riding the in-flight verdict
			// the anti-stampede window: exactly one knock exists
			expect(knocks).toBe(1);
			knock.settle(Response.json({ ok: true }));
			expect((await leader).kind).toBe("upstream");
			// after a success verdict the account is open: each rider
			// delivers on its own knock (post-verdict, pool-paced) —
			// coalescing bounds the PENDING window, it never dedups bodies.
			for (const f of followers) expect((await f).kind).toBe("upstream");
			expect(knocks).toBe(4);
			expect(router.cooldowns.cold.snapshot()).toEqual([]);
		});
	});
});

test.describe("@unit", () => {
	const dep = (group = "g"): Deployment => ({
		group,
		url: "http://a",
		dialect: "openai",
	});

	test("snapshot never labels an untouched placeholder as a provider rate limit", () => {
		let now = 1_000;
		const cold = new ColdMarks(
			() => now,
			undefined,
			() => 0,
		);
		expect(cold.state(dep())).toBe("none");
		expect(cold.claimProbe(dep())).toBe(true); // stamps the placeholder
		expect(cold.claimProbe(dep())).toBe(false); // the burst rides
		const rows = cold.snapshot();
		expect(rows).toEqual([
			{
				key: "g|http://a",
				groups: [],
				reason: "none",
				state: "pending",
				remainingS: 0,
			},
		]);
		// bounded pending advice counts down to the stale horizon
		expect(cold.pendingS(dep())).toBe(30);
		now += 29_000;
		expect(cold.pendingS(dep())).toBe(1);
		// the knock answers healthy: placeholder retired, snapshot clean
		cold.success(dep());
		expect(cold.snapshot()).toEqual([]);
		expect(cold.state(dep())).toBe("none");
	});

	test("a real cooldown verdict still renders rate/quota rows with remaining time", () => {
		let now = 1_000;
		const cold = new ColdMarks(
			() => now,
			undefined,
			() => 0,
		);
		cold.cool(dep(), { retryAfterS: 7, quota: false });
		expect(cold.snapshot()).toEqual([
			{
				key: "g|http://a",
				groups: ["g"],
				reason: "rate",
				state: "cold",
				remainingS: 7,
			},
		]);
		now += 7_000;
		expect(cold.claimProbe(dep())).toBe(true); // half-open probe claimed
		expect(cold.snapshot()[0]).toMatchObject({
			reason: "rate",
			state: "probe-busy",
		});
		expect(cold.pendingS(dep())).toBe(30); // probe horizon advice
	});
});
