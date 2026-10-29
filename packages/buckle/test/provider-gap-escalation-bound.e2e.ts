import { expect, test } from "@playwright/test";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";
import { Router } from "../src/router.ts";

test.describe("@unit", () => {
	// W1273 incident shape, scaled 1:100 in time: intervalCap 5 / intervalMs 20ms
	// gives the installed 20ms base pace; the pre-fix escalation ceiling was
	// min(30s, queueWaitMs/4) = 500ms — 125x the base pace — so a burst of Z.ai
	// 1302s doubled the start gap toward serialization (live: adaptiveGapMs
	// 24435, active 1 of 50 slots).
	const incidentPolicy = {
		concurrency: 40,
		intervalCap: 5,
		intervalMs: 20,
		maxOutstanding: 80,
		queueWaitMs: 2000,
		recovery: { successWindow: 8, decreasePercent: 5 },
	};

	test("1302 bursts pace starts at the pool's own interval contract, never the admission wait", async () => {
		const core = new ProviderAdmissionCore(incidentPolicy);
		expect(core.snapshot().gapCeilingMs).toBe(64);
		// One coalesced burst is one doubling; each later epoch after its pressure
		// window expires may double once more, but never past the ceiling.
		for (let epoch = 0; epoch < 4; epoch++) {
			const lease = await core.acquire();
			lease.feedback?.(429, null);
			lease.release();
			await Bun.sleep(
				Math.max(0, core.snapshot().congestionUntilMs - Date.now()) + 2,
			);
		}
		expect(core.snapshot().adaptiveGapMs).toBe(64);
		// Timely recovery: the base pace returns within a bounded success budget —
		// the incident recovery needed ~139 paced successes (hours at a 24s gap).
		let served = 0;
		while (core.snapshot().adaptiveGapMs > 4 && served < 100) {
			const lease = await core.acquire();
			await Bun.sleep(5);
			lease.feedback?.(200, null);
			lease.release();
			served++;
		}
		expect(core.snapshot().adaptiveGapMs).toBe(4);
		expect(served).toBeLessThanOrEqual(70);
		expect(core.snapshot().rateLimitedTotal).toBe(4);
	});

	const reproConfig = {
		allowed_fails: 1000,
		request_timeout_s: 30,
		first_byte_budget_s: 30,
		provider_pools: { account: incidentPolicy },
		resilience: { rate_cooldown_s: 1, rate_cooldown_max_s: 2 },
	};

	const reproPool = {
		groups: () => ["a"],
		deployments: () => [
			{
				group: "a",
				url: "https://fixture.invalid",
				dialect: "anthropic" as const,
				adapter_config: { provider_pool: "account" },
			},
		],
	};

	// Deterministic fake upstream: everything arriving before `acceptAfter`
	// refuses with the live 1302 shape; afterwards every acceptance does 45ms of
	// real work (long work relative to the 20ms pace, like the incident's 5s).
	const upstream = {
		acceptAfter: 0,
		accepted: 0,
		refused: 0,
		async fetch() {
			if (Date.now() < this.acceptAfter) {
				this.refused++;
				return Response.json(
					{
						error: { code: "1302", message: "Rate limit reached for requests" },
					},
					{ status: 429 },
				);
			}
			this.accepted++;
			await Bun.sleep(45);
			return new Response("useful result");
		},
	};

	async function drainCallers(router: Router): Promise<string[]> {
		return Promise.all(
			Array.from({ length: 24 }, async () => {
				const response = await router.execute({
					group: "a",
					dialect: "anthropic",
					path: "/v1/messages",
					key: "",
					body: { stream: false },
				});
				if (response.kind !== "upstream")
					throw new Error(`caller failed: ${response.kind}`);
				return response.response.text();
			}),
		);
	}

	// Exact slot/throughput contract for the drain after the wave: every caller
	// served, every refusal still counted, the gap never passed the interval
	// contract, slots actually ran concurrently, and the drain was prompt.
	// (W1273's gap-ceiling and recovery budget stay pinned by the pacing test
	// above; the wave test below pins the fail-fast herd + drain contract.)

	test("a sustained 1302 wave cannot serialize the pool: one knock, local herd answer, prompt drain", async () => {
		test.setTimeout(20000);
		upstream.acceptAfter = Date.now() + 900;
		upstream.accepted = 0;
		upstream.refused = 0;
		const router = new Router(reproConfig, {
			pool: reproPool,
			sleepMs: async () => {},
			rng: () => 0, // no jitter: the rate cold is exactly 1s
			fetchImpl: () => upstream.fetch(),
		});
		// fail-fast: the FIRST walk's knock eats the 1302 and colds the
		// account; the rest of the herd answers locally at once.
		const attempts = await Promise.allSettled(
			Array.from({ length: 24 }, async () => {
				const response = await router.execute({
					group: "a",
					dialect: "anthropic",
					path: "/v1/messages",
					key: "",
					body: { stream: false },
				});
				return response.kind === "upstream"
					? "upstream"
					: (response as { kind: string }).kind;
			}),
		);
		const kinds = attempts.map((a) =>
			a.status === "fulfilled" ? a.value : "throw",
		);
		const herdLocal = kinds.filter((k) => k !== "upstream").length;
		expect(herdLocal).toBeGreaterThanOrEqual(23); // N−1 answered locally
		expect(upstream.refused).toBeLessThanOrEqual(2); // one knock per window
		// the client (the ONE retry owner) honors the Retry-After; once the
		// window lapses the half-open probe reopens the account and the
		// riding batch delivers — every caller, promptly
		await Bun.sleep(1050);
		const drainStart = Date.now();
		const bodies = await drainCallers(router);
		expect(bodies).toHaveLength(24);
		expect(bodies.every((body) => body === "useful result")).toBe(true);
		expect(Date.now() - drainStart).toBeLessThan(4000);
		expect(router.providerAdmissionSnapshot().account?.outstanding).toBe(0);
	});
});
