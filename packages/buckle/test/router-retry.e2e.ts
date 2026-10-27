// test/router-retry.test.ts — retry-after honored + cooldown ejection in
// the walk (mock upstreams, immediate sleeps, deterministic rng).
import { expect, test } from "@playwright/test";
import type { GatewayPolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

test.describe({ tag: "@unit" }, () => {
	const POLICY: GatewayPolicy = {
		num_retries: 1,
		allowed_fails: 3,
		cooldown_time: 30,
	};

	function poolOf(entries: Array<[string, string[]]>): UpstreamPool {
		const map = new Map(entries);
		return {
			groups: () => [...map.keys()],
			deployments: (g) =>
				(map.get(g) ?? []).map((url) => ({
					group: g,
					url,
					dialect: "openai" as const,
				})),
		};
	}

	test.describe("retry + cooldown in the walk", () => {
		test("four concurrent 503 refusals advance to the healthy fallback without sleeping", async () => {
			const attempted: string[] = [];
			const slept: number[] = [];
			const router = new Router(
				{
					...POLICY,
					num_retries: 0,
					retry_after_cap_s: 1,
					fallbacks: { primary: ["local"] },
				},
				{
					pool: poolOf([
						["primary", ["http://primary"]],
						["local", ["http://local"]],
					]),
					sleepMs: async (ms) => {
						slept.push(ms);
					},
					fetchImpl: async (dep) => {
						attempted.push(dep.group);
						return dep.group === "primary"
							? new Response("warming", {
									status: 503,
									headers: { "retry-after": "60" },
								})
							: Response.json({ ok: true });
					},
				},
			);
			const requests = Array.from({ length: 4 }, () =>
				router.execute({
					group: "primary",
					dialect: "openai",
					path: "/v1/chat/completions",
					body: { model: "primary", stream: false },
					key: "",
				}),
			);
			const results = await Promise.all(requests);
			expect(
				results.every((r) => r.kind === "upstream" && r.tier === "local"),
			).toBe(true);
			expect(attempted.filter((g) => g === "local")).toHaveLength(4);
			// no spin: exactly one primary refusal per request — with num_retries=0
			// the Retry-After must never buy a same-tier retry loop or a wait.
			expect(attempted.filter((g) => g === "primary")).toHaveLength(4);
			expect(slept).toEqual([]);
		});

		test("a retry budget may try a different same-tier candidate without inheriting the first wait", async () => {
			const attempted: string[] = [];
			const slept: number[] = [];
			const router = new Router(
				{ ...POLICY, num_retries: 1, retry_after_cap_s: 1 },
				{
					pool: poolOf([["primary", ["http://cold", "http://healthy"]]]),
					sleepMs: async (ms) => {
						slept.push(ms);
					},
					fetchImpl: async (dep) => {
						attempted.push(dep.url);
						return dep.url === "http://cold"
							? new Response("warming", {
									status: 503,
									headers: { "retry-after": "60" },
								})
							: Response.json({ ok: true });
					},
				},
			);
			const result = await router.execute({
				group: "primary",
				dialect: "openai",
				path: "/v1/chat/completions",
				body: { model: "primary" },
				key: "",
			});
			expect(result.kind).toBe("upstream");
			expect(attempted).toEqual(["http://cold", "http://healthy"]);
			expect(slept).toEqual([]);
		});

		test("exhausted 503 preserves bounded Retry-After and last-hop evidence", async () => {
			const router = new Router(
				{ ...POLICY, num_retries: 0, retry_after_cap_s: 2 },
				{
					pool: poolOf([["primary", ["http://primary"]]]),
					fetchImpl: async () =>
						new Response("warming", {
							status: 503,
							headers: {
								"retry-after": "60",
								"x-request-id": "upstream-cold-1",
							},
						}),
				},
			);
			const result = await router.execute({
				group: "primary",
				dialect: "openai",
				path: "/v1/chat/completions",
				body: { model: "primary", stream: false },
				key: "",
			});
			expect(result.kind).toBe("exhausted");
			if (result.kind !== "exhausted") return;
			expect(result.status).toBe(503);
			expect(result.retryAfterS).toBe(2);
			expect(result.lastFailure).toMatchObject({
				source: "upstream",
				status: 503,
				requestId: "upstream-cold-1",
			});
		});

		test("a provider quota wall advances to the configured fallback without sleeping", async () => {
			const attempted: string[] = [];
			const slept: number[] = [];
			const router = new Router(
				{ ...POLICY, fallbacks: { claude: ["glm"] } },
				{
					pool: poolOf([
						["claude", ["http://copilot"]],
						["glm", ["http://glm"]],
					]),
					sleepMs: async (ms) => {
						slept.push(ms);
					},
					fetchImpl: async (dep) => {
						attempted.push(dep.url);
						return dep.group === "claude"
							? new Response("quota exceeded", {
									status: 429,
									headers: { "retry-after": "996295" },
								})
							: Response.json({ ok: true });
					},
				},
			);
			const result = await router.execute({
				group: "claude",
				dialect: "openai",
				path: "/v1/chat/completions",
				body: { model: "claude", stream: false },
				key: "",
			});
			expect(result.kind).toBe("upstream");
			if (result.kind === "upstream") expect(result.tier).toBe("glm");
			expect(attempted).toEqual(["http://copilot", "http://glm"]);
			expect(slept).toEqual([]);
		});
		test("an exhausted quota wall relays the provider retry-after CLAMPED", async () => {
			const slept: number[] = [];
			const router = new Router(POLICY, {
				pool: poolOf([["claude", ["http://copilot"]]]),
				sleepMs: async (ms) => {
					slept.push(ms);
				},
				fetchImpl: async () =>
					new Response("quota exceeded", {
						status: 429,
						headers: { "retry-after": "996295" },
					}),
			});
			const result = await router.execute({
				group: "claude",
				dialect: "openai",
				path: "/v1/chat/completions",
				body: { model: "claude", stream: false },
				key: "",
			});
			expect(result.kind).toBe("client-error");
			if (result.kind === "client-error") {
				expect(result.response.status).toBe(429);
				// W1303.2: the weeks-long provider retry-after relays CLAMPED to
				// the kit max (default 300s) — a quota wall never sleeps a client
				// for weeks (the pre-clamp bug this test used to pin).
				expect(result.response.headers.get("retry-after")).toBe("300");
			}
			expect(slept).toEqual([]);
		});

		test("a rate-limited deployment answers a typed local 503 hold while benched, then recovers", async () => {
			let now = 1_000;
			let calls = 0;
			const router = new Router(
				{ ...POLICY, num_retries: 0, allowed_fails: 1, cooldown_time: 30 },
				{
					pool: poolOf([["glm", ["http://glm"]]]),
					now: () => now,
					fetchImpl: async () => {
						calls++;
						return calls === 1
							? new Response("quota exceeded", {
									status: 429,
									headers: { "retry-after": "7" },
								})
							: Response.json({ ok: true });
					},
				},
			);
			const req = {
				group: "glm",
				dialect: "openai" as const,
				path: "/v1/chat/completions",
				body: { model: "glm", stream: false },
				key: "",
			};
			const first = await router.execute(req);
			expect(first.kind).toBe("client-error");
			// W1257: inside the bench window the gateway answers a typed LOCAL
			// 503 hold carrying the provider's last-seen refusal words as
			// attributed context — never a fabricated provider 429
			const benched = await router.execute(req);
			expect(benched.kind).toBe("exhausted");
			if (benched.kind !== "exhausted") throw new Error("rate limit lost");
			expect(benched.status).toBe(503);
			expect(benched.retryAfterS).toBe(30);
			expect(benched.error).toContain("gateway cooldown");
			expect(benched.error).toContain("not the provider");
			expect(calls).toBe(1);
			now += 30_000;
			expect((await router.execute(req)).kind).toBe("upstream");
			expect(calls).toBe(2);
		});

		test("upstream retry-after is honored before the same-tier retry", async () => {
			let calls = 0;
			const slept: number[] = [];
			const policy = { ...POLICY, num_retries: 1 };
			const pool = poolOf([["g", ["http://only"]]]);
			const router = new Router(policy, {
				pool,
				rng: () => 0,
				sleepMs: async (ms) => {
					slept.push(ms);
				},
				fetchImpl: async () => {
					calls++;
					if (calls === 1) {
						return Response.json(
							{ e: 1 },
							{ status: 429, headers: { "retry-after": "0.05" } },
						);
					}
					return Response.json({ ok: true });
				},
			});
			const r = await router.execute({
				group: "g",
				dialect: "openai",
				path: "/v1/chat/completions",
				body: { model: "g", stream: false },
				key: "",
			});
			expect(r.kind).toBe("upstream");
			expect(calls).toBe(2);
			expect(slept).toEqual([1000]); // Provider floor honored, with a nonzero exponential minimum.
		});

		test("allowed_fails consecutive failures eject the deployment", async () => {
			let calls = 0;
			const policy = { ...POLICY, allowed_fails: 2 };
			const router = new Router(policy, {
				pool: poolOf([["g", ["http://only"]]]),
				rng: () => 0,
				sleepMs: async () => {},
				fetchImpl: async () => {
					calls++;
					return Response.json({ e: 1 }, { status: 500 });
				},
			});
			const req = {
				group: "g",
				dialect: "openai" as const,
				path: "/v1/chat/completions",
				body: { model: "g", stream: false },
				key: "",
			};
			const r1 = await router.execute(req);
			expect(r1.kind).toBe("exhausted");
			expect(calls).toBe(2); // 1 + num_retries
			const r2 = await router.execute(req);
			expect(r2.kind).toBe("exhausted");
			expect(calls).toBe(2); // benched — no new upstream calls
		});

		test("cooldown recovery: deployment retried after the window", async () => {
			let calls = 0;
			let t = 1000;
			const policy = { ...POLICY, allowed_fails: 2, cooldown_time: 30 };
			const router = new Router(policy, {
				pool: poolOf([["g", ["http://only"]]]),
				now: () => t,
				rng: () => 0,
				sleepMs: async () => {},
				fetchImpl: async () => {
					calls++;
					return calls <= 2
						? Response.json({ e: 1 }, { status: 500 })
						: Response.json({ ok: true });
				},
			});
			const req = {
				group: "g",
				dialect: "openai" as const,
				path: "/v1/chat/completions",
				body: { model: "g", stream: false },
				key: "",
			};
			expect((await router.execute(req)).kind).toBe("exhausted");
			t += 30_000;
			expect((await router.execute(req)).kind).toBe("upstream");
		});
	});
});
