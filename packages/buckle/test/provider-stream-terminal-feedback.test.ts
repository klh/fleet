import { expect, test } from "bun:test";
import {
	bindProviderLease,
	ProviderAdmissionCore,
} from "../src/provider-admission-core.ts";

const policy = {
	concurrency: 2,
	intervalCap: 2,
	intervalMs: 1,
	maxOutstanding: 10,
	queueWaitMs: 1000,
	recovery: { successWindow: 8, decreasePercent: 5 },
};

/** One provider-pool lease bound to a 200 SSE stream assembled from the
 *  given frames, split at adversarial chunk boundaries and drained to EOF. */
async function rideStream(
	core: ProviderAdmissionCore,
	frames: string[],
): Promise<void> {
	const bytes = new TextEncoder().encode(frames.join(""));
	const lease = await core.acquire();
	const response = bindProviderLease(
		new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					for (let i = 0; i < bytes.length; i += 7)
						c.enqueue(bytes.subarray(i, i + 7));
					c.close();
				},
			}),
			{ status: 200 },
		),
		lease,
	);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("fixture body missing");
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
	}
}

const rateLimited1302 =
	'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","code":"1302","message":"Rate limit reached"}}\n\n';

test("HTTP200 Responses SSE response.failed is refusal evidence, never healthy EOF", async () => {
	const core = new ProviderAdmissionCore(policy);
	await rideStream(core, [
		'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
		'data: {"type":"response.failed","response":{"error":{"code":"1302","message":"no capacity"}}}\n\n',
		"data: [DONE]\n\n",
	]);
	const snap = core.snapshot();
	expect(snap.rateLimitedTotal).toBe(1);
	expect(snap.recoverySuccesses).toBe(0);
	expect(snap.adaptiveGapMs).toBe(snap.baseGapMs * 2);
	expect(snap.adaptiveConcurrency).toBe(policy.concurrency);
});

test("uncoded response.failed stays neutral — no healthy credit, no fake 429", async () => {
	const core = new ProviderAdmissionCore(policy);
	await rideStream(core, [
		'data: {"type":"response.failed","response":{"error":null}}\n\n',
		"data: [DONE]\n\n",
	]);
	const snap = core.snapshot();
	expect(snap.rateLimitedTotal).toBe(0);
	expect(snap.recoverySuccesses).toBe(0);
	expect(snap.adaptiveGapMs).toBe(snap.baseGapMs);
});

test("response.incomplete with no provider code stays neutral too", async () => {
	const core = new ProviderAdmissionCore(policy);
	await rideStream(core, [
		'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
	]);
	const snap = core.snapshot();
	expect(snap.rateLimitedTotal).toBe(0);
	expect(snap.recoverySuccesses).toBe(0);
	expect(snap.adaptiveGapMs).toBe(snap.baseGapMs);
});

test("generic 1302 on a 200 stream paces rate pressure without collapsing concurrency", async () => {
	const core = new ProviderAdmissionCore(policy);
	await rideStream(core, [rateLimited1302, "data: [DONE]\n\n"]);
	const snap = core.snapshot();
	expect(snap.rateLimitedTotal).toBe(1);
	expect(snap.concurrencyLimitedTotal).toBe(0);
	expect(snap.adaptiveConcurrency).toBe(policy.concurrency);
	expect(snap.adaptiveGapMs).toBe(snap.baseGapMs * 2);
	// healthy recovery re-arms after the refusal window through the SAME
	// EOF credit path a clean stream rides
	await Bun.sleep(12);
	await rideStream(core, [
		'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
		"data: [DONE]\n\n",
	]);
	expect(core.snapshot().recoverySuccesses).toBe(1);
});

test("declared account-occupancy codes still collapse via in-band classification", async () => {
	const core = new ProviderAdmissionCore({
		...policy,
		concurrencyErrorCodes: ["1302"],
	});
	await rideStream(core, [rateLimited1302, "data: [DONE]\n\n"]);
	const snap = core.snapshot();
	expect(snap.concurrencyLimitedTotal).toBe(1);
	expect(snap.rateLimitedTotal).toBe(1);
	expect(snap.adaptiveConcurrency).toBeLessThan(policy.concurrency);
});

test("typed upstream failures (1113 balance, 1311 entitlement) never pace", async () => {
	for (const [code, type] of [
		["1113", "insufficient_balance"],
		["1311", "model_access_denied"],
	] as const) {
		const core = new ProviderAdmissionCore(policy);
		await rideStream(core, [
			`event: error\ndata: {"type":"error","error":{"type":"${type}","code":"${code}","message":"typed upstream failure"}}\n\n`,
			"data: [DONE]\n\n",
		]);
		const snap = core.snapshot();
		expect(snap.rateLimitedTotal).toBe(0);
		expect(snap.concurrencyLimitedTotal).toBe(0);
		expect(snap.recoverySuccesses).toBe(0);
		expect(snap.adaptiveGapMs).toBe(snap.baseGapMs);
		expect(snap.adaptiveConcurrency).toBe(policy.concurrency);
	}
});

test("clean completed streams still credit healthy transport EOF", async () => {
	const core = new ProviderAdmissionCore(policy);
	// engage pacing first — the recovery counters only run under pressure
	const lease = await core.acquire();
	lease.feedback?.(429, null);
	lease.release();
	// the congestion window from the 429 must pass before EOF counts
	await Bun.sleep(12);
	await rideStream(core, [
		'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
		"data: [DONE]\n\n",
	]);
	expect(core.snapshot().recoverySuccesses).toBe(1);
	expect(core.snapshot().rateLimitedTotal).toBe(1);
});
