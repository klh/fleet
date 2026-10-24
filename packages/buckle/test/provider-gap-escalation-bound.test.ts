import { expect, test } from "bun:test";
import { ProviderAdmissionCore } from "../src/provider-admission-core.ts";
import { Router } from "../src/router.ts";

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
	expect(core.snapshot().gapCeilingMs).toBe(20);
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
	expect(core.snapshot().adaptiveGapMs).toBe(20);
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
	expect(served).toBeLessThanOrEqual(45);
	expect(core.snapshot().rateLimitedTotal).toBe(4);
});

const reproConfig = {
	num_retries: 20,
	allowed_fails: 1000,
	request_timeout_s: 30,
	first_byte_budget_s: 30,
	provider_pools: { account: incidentPolicy },
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
				{ error: { code: "1302", message: "Rate limit reached for requests" } },
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
function expectProductiveDrain(
	bodies: string[],
	refused: number,
	router: Router,
	peakGap: number,
	peakActive: number,
	wallMs: number,
) {
	const snap = router.providerAdmissionSnapshot().account;
	expect(bodies).toHaveLength(24);
	expect(bodies.every((body) => body === "useful result")).toBe(true);
	expect(refused).toBeGreaterThanOrEqual(10);
	expect(snap?.rateLimitedTotal).toBe(refused);
	expect(peakGap).toBeGreaterThanOrEqual(8);
	expect(peakGap).toBeLessThanOrEqual(20);
	// A serialized pool (pre-fix: 500ms gap vs 45ms work) holds exactly ONE
	// active lease; paced starts at the 20ms contract overlap the 45ms work.
	expect(peakActive).toBeGreaterThanOrEqual(2);
	expect(wallMs).toBeLessThan(4000);
	expect(snap?.outstanding).toBe(0);
}

test("a sustained 1302 wave cannot serialize the pool: slots stay productive and drain promptly", async () => {
	upstream.acceptAfter = Date.now() + 900;
	upstream.accepted = 0;
	upstream.refused = 0;
	const router = new Router(reproConfig, {
		pool: reproPool,
		sleepMs: async () => {},
		fetchImpl: () => upstream.fetch(),
	});
	const start = Date.now();
	let peakGap = 0;
	let peakActive = 0;
	const sampler = setInterval(() => {
		const snap = router.providerAdmissionSnapshot().account;
		if (!snap) return;
		peakGap = Math.max(peakGap, snap.adaptiveGapMs);
		peakActive = Math.max(peakActive, snap.active);
	}, 10);
	const bodies = await drainCallers(router);
	clearInterval(sampler);
	expectProductiveDrain(
		bodies,
		upstream.refused,
		router,
		peakGap,
		peakActive,
		Date.now() - start,
	);
}, 20000);
