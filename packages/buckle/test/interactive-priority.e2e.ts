// W2617: interactive sessions get priority over lanes on shared upstream
// rate limits (z.ai 1302). Router seam (mocked fetchImpl): under a stubbed
// 1302 upstream at capacity, an interactive-class request waits the ONE
// bounded cold-wait and is served while lane-class traffic is answered
// locally (429 + Retry-After, zero knocks). ProviderAdmissionCore seam:
// interactive priority dequeues ahead of an earlier-queued lane, and a
// pool paused by 1302 pressure sheds lanes instantly while interactive
// callers keep the queue. Ingress: mint-name classification.
import { expect, test } from "@playwright/test";
import { parsePolicy } from "../src/policy.ts";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";
import { parseResilience, trafficClassOf } from "../src/resilience-config.ts";
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
				"concurrency": 1,
				"intervalCap": 100,
				"intervalMs": 50,
				"maxOutstanding": 8,
				"queueWaitMs": 1000,
				"recovery": { "successWindow": 8, "decreasePercent": 5 }
			}
		}
	}
}`);

	const POOL = POLICY.provider_pools?.["zai-main"];
	if (POOL === undefined) throw new Error("fixture pool zai-main missing");

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

	const req = (group: string, trafficClass?: "lane" | "interactive") => ({
		group,
		dialect: "openai" as const,
		path: "/v1/chat/completions",
		body: { model: group } as Record<string, unknown>,
		key: "",
		...(trafficClass === undefined ? {} : { trafficClass }),
	});

	test.describe("ingress classification (mint name → class)", () => {
		test("dispatch-minted lane names are lanes; interactive keys are not", () => {
			const cfg = parseResilience({});
			expect(trafficClassOf("autow2617-p98b319584008df14", cfg)).toBe("lane");
			expect(trafficClassOf("review-f65879d7", cfg)).toBe("lane");
			expect(trafficClassOf("ramp-12", cfg)).toBe("lane");
			expect(trafficClassOf("claude-cli-interactive", cfg)).toBe("interactive");
			expect(trafficClassOf("root", cfg)).toBe("interactive");
			expect(trafficClassOf(null, cfg)).toBe("interactive");
			expect(trafficClassOf("", cfg)).toBe("interactive");
		});
	});

	test.describe("W2617 interactive priority", () => {
		test("under a 1302 cold mark, an interactive request is served while a lane is refused locally", async () => {
			// Upstream: first knock answers z.ai 1302 (rate-shaped, fractional
			// Retry-After so the cold window is sub-second); every later knock
			// succeeds — capacity exists for whoever reaches the wire.
			let fetches = 0;
			const router = new Router(POLICY, {
				pool: poolOf([dep("http://a", "m1", "zai-main")]),
				sleepMs: (ms, signal) =>
					new Promise((resolve) => {
						if (signal?.aborted) return resolve();
						const t = setTimeout(resolve, ms);
						signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(t);
								resolve();
							},
							{ once: true },
						);
					}),
				fetchImpl: async () => {
					fetches++;
					return fetches === 1
						? new Response(
								JSON.stringify({
									error: {
										code: "1302",
										message: "Rate limit reached for requests",
									},
								}),
								{
									status: 429,
									headers: { "retry-after": "0.4" },
								},
							)
						: Response.json({ ok: true });
				},
			});
			// A lane request eats the 1302 → the shared cold mark colds the
			// account for every caller (anti-stampede, unchanged).
			const first = await router.execute(req("m1", "lane"));
			expect(first.kind).toBe("client-error");
			if (first.kind === "client-error")
				expect(first.failureKind).toBe("rate_limited");
			// A second lane inside the cold window: instant LOCAL 429 (no
			// fetch, no wait) — lanes back off on 1302 before interactive is
			// refused.
			const laneAgain = await router.execute(req("m1", "lane"));
			expect(laneAgain.kind).toBe("exhausted");
			if (laneAgain.kind === "exhausted") {
				expect(laneAgain.status).toBe(429);
				expect(laneAgain.error).toContain("cold mark");
			}
			expect(fetches).toBe(1);
			// Interactive inside the same window: ONE bounded wait for the
			// short rate-shaped cold to lapse, then it claims the half-open
			// probe itself and is SERVED — never the instant refusal.
			const served = await router.execute(req("m1", "interactive"));
			expect(served.kind).toBe("upstream");
			if (served.kind === "upstream")
				await served.response.text().catch(() => {});
			expect(fetches).toBe(2);
		});

		test("a queued interactive request dequeues ahead of an earlier queued lane", async () => {
			const core = new ProviderAdmissionCore(POOL);
			const grants: string[] = [];
			const holder = await core.acquire();
			// lane enqueues FIRST (priority 0), interactive second (priority
			// 1); each releases on grant so the next in order dequeues
			const lane = core.acquire(undefined, 5_000, 0).then((l) => {
				grants.push("lane");
				l.release();
			});
			const live = core.acquire(undefined, 5_000, 1).then((l) => {
				grants.push("live");
				l.release();
			});
			await Bun.sleep(30); // both queued behind the held slot
			holder.release();
			await Promise.all([lane, live]);
			expect(grants).toEqual(["live", "lane"]);
		});

		test("a pool paused by 1302 pressure sheds lanes instantly; interactive keeps the queue", async () => {
			const core = new ProviderAdmissionCore(POOL);
			const holder = await core.acquire();
			// the in-flight request eats the 1302: rate pressure pauses starts
			// (notBefore) for the refused burst
			holder.feedback?.(429, 1, "rate", "1302");
			holder.release();
			await Bun.sleep(10);
			// lane: refused NOW with the honest pause remainder — it fails
			// over or retries; it never occupies the recovering window
			const lane = await core.acquire(undefined, 5_000, 0).then(
				(l) => l,
				(e: { message: string; retryAfterMs: number | null }) => e,
			);
			expect(lane).toMatchObject({
				message: "Provider pool shedding lane traffic under rate pressure",
			});
			// interactive: still admitted through the bounded queue (the
			// pause is ~1s; the interactive wait rides it out and is served)
			const live = await core.acquire(undefined, 5_000, 1);
			live.release();
			expect(core.snapshot().rateLimitedTotal).toBe(1);
		});
	});
});
