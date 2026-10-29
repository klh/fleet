// test/stream-breaker.e2e.ts — W2266: the terminal-SSE failure circuit
// breaker. The live 2026-10-29 incident: HTTP 200, then stream_failed /
// stream_truncated on every request while configured priority kept selecting
// the same deployment — recordOutcome banked success=false but nothing
// benched the row. Two-upstream regression: repeated post-header failures
// demote the first row (the next request heads the healthy alternate), the
// probe after the cooldown window restores it, and a downstream cancel never
// counts as an upstream failure.
import { expect, test } from "@playwright/test";
import { sseHeaders } from "@klh/test-kit";
import { Cooldowns } from "../src/cooldown.ts";
import { createApp } from "../src/handlers.ts";
import { StreamBreaker } from "../src/stream-breaker.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const ANTHROPIC_START =
	'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n';
const ANTHROPIC_TEXT =
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
	'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n';

const ANTHROPIC_STOP =
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

/** Truncating upstream: HTTP 200 + SSE headers, one real chunk, then EOF
 *  without the dialect terminal — the incident's post-header failure. */
const TRUNCATING = (): Response =>
	new Response(ANTHROPIC_START, { headers: sseHeaders });

/** Healthy upstream: full turn with the protocol terminal. */
const HEALTHY = (): Response =>
	new Response(ANTHROPIC_START + ANTHROPIC_TEXT + ANTHROPIC_STOP, { headers: sseHeaders });

/** Two-row pool for one pinned group: explicit priorities so the decision
 *  provably rides "configured priority" — not the proven-latency tiebreak. */
const poolOf2 = (bad: string, good: string): UpstreamPool => ({
	groups: () => ["claude-sonnet-5"],
	deployments: (g) => [
		{ group: g, url: bad, dialect: "anthropic" as const, priority: 1 },
		{ group: g, url: good, dialect: "anthropic" as const, priority: 2 },
	],
});

/** One streaming chat request through the full app; resolves after the
 *  client drained the body and the receipt settled. */
const streamChat = async (
	app: { fetch: (req: Request) => Promise<Response> },
	url: string,
): Promise<string> => {
	const res = await app.fetch(
		new Request(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
		}),
	);
	const text = await res.text();
	await Bun.sleep(20); // pipes + receipt settle
	return text;
};

test.describe("@unit", () => {
	test.describe("StreamBreaker unit", () => {
		const mkDep = (url: string) => ({
			group: "g",
			url,
			dialect: "openai" as const,
		});

		test("benches after stream_allowed_fails consecutive failures, recovers on the clock", () => {
			let t = 1_000_000;
			const cd = new Cooldowns(3, 30, () => t);
			const br = new StreamBreaker(cd, { allowedFails: 2, cooldownS: 45 });
			const d = mkDep("http://bad");
			br.terminal(d, { kind: "failed", failureKind: "timeout" });
			expect(cd.benched(d)).toBe(false);
			br.terminal(d, { kind: "truncated" });
			expect(cd.benched(d)).toBe(true);
			t += 46_000; // the window rides the cooldowns clock
			expect(cd.benched(d)).toBe(false);
		});

		test("completed resets; cancels and drain cuts never count", () => {
			let t = 1_000_000;
			const cd = new Cooldowns(3, 30, () => t);
			const br = new StreamBreaker(cd, { allowedFails: 2, cooldownS: 45 });
			const d = mkDep("http://x");
			br.terminal(d, { kind: "failed", failureKind: "timeout" });
			br.terminal(d, { kind: "completed" }); // recovery reset
			expect(cd.benched(d)).toBe(false);
			br.terminal(d, { kind: "failed", failureKind: "timeout" });
			expect(cd.benched(d)).toBe(false); // reset took: 1 of 2
			br.terminal(d, { kind: "downstream_cancel" }); // client's, not upstream's
			br.terminal(d, { kind: "drain_cut" }); // gateway's own restart
			expect(cd.benched(d)).toBe(false);
			br.terminal(d, { kind: "failed", failureKind: "timeout" });
			expect(cd.benched(d)).toBe(true); // 2 real upstream failures
		});
	});
});

test.describe("@api", () => {
	const POLICY = {
		num_retries: 1,
		allowed_fails: 3,
		cooldown_time: 30,
		stream_allowed_fails: 2,
		stream_cooldown_time_s: 45,
	};

	test("repeated post-header failures demote the first row; the probe after the window restores it", async () => {
		let t = 1_000_000;
		const bad = await startMockUpstream(TRUNCATING);
		const good = await startMockUpstream(HEALTHY);
		try {
			const deps = testDeps(poolOf2(bad.url, good.url), {
				policy: POLICY,
				now: () => t,
			});
			const app = createApp(deps);

			// requests 1+2: configured priority keeps heading the failing row
			await streamChat(app, bad.url);
			await streamChat(app, bad.url);
			expect(bad.calls.length).toBe(2);
			expect(good.calls.length).toBe(0);
			const badRow = deps.ledger.auditRows().at(-1) ?? {};
			expect(badRow.err).toBe("stream_truncated"); // the incident receipt

			// the breaker benched it — the NEXT request heads the alternate
			await streamChat(app, bad.url);
			expect(good.calls.length).toBe(1); // the healthy alternate delivered
			expect(bad.calls.length).toBe(2); // the benched row stayed cold
			const goodRow = deps.ledger.auditRows().at(-1) ?? {};
			expect(goodRow.ok).toBe(1);

			// the probe after the cooldown window restores the first row —
			// t advances past the bench; the table health tick (5s in
			// production) re-reads benched() and re-marks the row healthy.
			t += 46_000;
			deps.table.rebuild();
			await streamChat(app, bad.url);
			expect(bad.calls.length).toBe(3); // priority one again (the probe)
		} finally {
			bad.close();
			good.close();
		}
	});

	test("a downstream cancel never benches the delivering row", async () => {
		let t = 1_000_000;
		const bad = await startMockUpstream(TRUNCATING);
		const good = await startMockUpstream(HEALTHY);
		try {
			const deps = testDeps(poolOf2(bad.url, good.url), {
				policy: POLICY,
				now: () => t,
			});
			const app = createApp(deps);

			// one real failure (1 of 2)...
			await streamChat(app, bad.url);
			expect(bad.calls.length).toBe(1);
			// ...then the CLIENT walks: cancel mid-stream on the failing row
			const res = await app.fetch(
				new Request(`${bad.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
				}),
			);
			const reader = res.body?.getReader();
			await reader?.read();
			await reader?.cancel("client gone");
			await Bun.sleep(80);
			const cancelRow = deps.ledger.auditRows().at(-1) ?? {};
			expect(cancelRow.err).toBe("downstream_cancel");

			// the cancel must NOT have completed the demotion — priority one
			// still heads (2 real upstream failures needed, only 1 banked)
			await streamChat(app, bad.url);
			expect(bad.calls.length).toBe(3);
			expect(good.calls.length).toBe(0);

			// req3's own truncation was the 2nd REAL failure — the breaker
			// benches bad right there: the next request heads the alternate
			await streamChat(app, bad.url);
			expect(good.calls.length).toBe(1);
			expect(bad.calls.length).toBe(3);
		} finally {
			bad.close();
			good.close();
		}
	});
});
