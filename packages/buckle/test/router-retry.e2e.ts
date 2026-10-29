// test/router-retry.test.ts — retry-after honored + cooldown ejection in
// the walk (mock upstreams, immediate sleeps, deterministic rng).
import { expect, test } from "@playwright/test";
import type { GatewayPolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

test.describe("@unit", () => {
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

		test("a rate-limited deployment answers the shared cold mark locally, then recovers via the half-open probe", async () => {
			let now = 1_000;
			let calls = 0;
			const router = new Router(
				{ ...POLICY, num_retries: 0, allowed_fails: 1, cooldown_time: 30 },
				{
					pool: poolOf([["glm", ["http://glm"]]]),
					now: () => now,
					rng: () => 0,
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
			if (first.kind === "client-error") {
				// the provider's own 429 relays verbatim with its Retry-After
				expect(first.response.status).toBe(429);
				expect(first.response.headers.get("retry-after")).toBe("7");
			}
			// N → 1: the shared cold mark answers the next caller LOCALLY from
			// the banked provider refusal — no second knock, honest remainder
			const benched = await router.execute(req);
			expect(benched.kind).toBe("exhausted");
			if (benched.kind !== "exhausted") throw new Error("rate limit lost");
			expect(benched.status).toBe(429);
			expect(benched.retryAfterS).toBe(7);
			expect(benched.error).toContain("shared cold mark");
			expect(benched.error).toContain("not the provider");
			expect(calls).toBe(1);
			now += 7_000;
			// expiry → the single half-open probe knocks and delivers
			expect((await router.execute(req)).kind).toBe("upstream");
			expect(calls).toBe(2);
		});

		test("upstream retry-after relays clamped; the single-candidate walk answers at once", async () => {
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
			// fail-fast: one knock, the refusal relays (W1303.2 clamp floors
			// the sub-second provider RA at 1), the OUTER client owns the retry
			expect(r.kind).toBe("client-error");
			expect(calls).toBe(1);
			expect(slept).toEqual([]);
		});

		test("allowed_fails consecutive failures eject the deployment", async () => {
			let calls = 0;
			const policy = { ...POLICY, allowed_fails: 2 };
			const router = new Router(policy, {
				pool: poolOf([["g", ["http://only"]]]),
				rng: () => 0,
				sleepMs: async () => {},
				// the ejected leg's liveness probe stays dead — no third knock
				probe: async () => null,
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
			expect(calls).toBe(1); // fail-fast: one knock per walk
			const r2 = await router.execute(req);
			expect(r2.kind).toBe("exhausted");
			expect(calls).toBe(2); // second knock reaches allowed_fails → eject
			const r3 = await router.execute(req);
			expect(r3.kind).toBe("exhausted");
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
			// fail-fast: walk 1 reaches allowed_fails (one knock), walk 2's
			// knock ejects; the recovery probe rides walk 3 after the window
			expect((await router.execute(req)).kind).toBe("exhausted");
			expect(calls).toBe(1);
			expect((await router.execute(req)).kind).toBe("exhausted");
			expect(calls).toBe(2); // ejected — benched from here
			t += 30_000;
			expect((await router.execute(req)).kind).toBe("upstream");
			expect(calls).toBe(3);
		});
	});
});
