// test/w2579-scoped-idle.e2e.ts — W2579 co-situated proof: the per-group
// stream idle override reaches the WIRE, not just the parse. One app, two
// groups, one scoped override: the overridden group's stall must survive a
// global idle deadline that kills the unlisted group's identical stall.
// The C235 incident shape (role-frame-then-silence) doubles as the
// role-only classification proof: the killed leg banks
// upstream_deadline_role_only, the surviving leg completes.
import { sseEnc as enc, sseHeaders } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const receiptOf = (audit: Record<string, unknown>): Record<string, unknown> =>
	JSON.parse(String(audit.stream_receipt ?? "{}")) as Record<string, unknown>;

test.describe("@unit W2579 scoped stream idle", () => {
	test("scoped override extends ONE group's idle deadline at the wire", async () => {
		// both groups stall identically: role frame, then silence forever
		const stall = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(
							enc.encode(
								'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
							),
						);
					},
				}),
				{ headers: sseHeaders },
			);
		const listed = await startMockUpstream(stall);
		const unlisted = await startMockUpstream(stall);
		try {
			const deps = testDeps(
				{
					groups: () => ["glm-5.3", "gpt-5.2"],
					deployments: (g: string) => [
						{
							group: g,
							url: g === "glm-5.3" ? listed.url : unlisted.url,
							dialect: "anthropic" as const,
						},
					],
				},
				{
					policy: {
						num_retries: 0,
						stream_idle_timeout_s: 0.2,
						stream_idle_overrides_s: { "glm-5.3": 30 },
						stream_total_timeout_s: 60,
					},
				},
			);
			const app = createApp(deps);
			// unlisted group: the 0.2s global idle kills the stall
			const t0 = Date.now();
			const killed = await app.fetch(
				new Request(`${unlisted.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "gpt-5.2", stream: true }),
				}),
			);
			expect(killed.status).toBe(200);
			await killed.text();
			const killElapsed = Date.now() - t0;
			expect(killElapsed).toBeLessThan(5_000);
			await Bun.sleep(20);
			const killedAudit = deps.ledger.auditRows()[0] ?? {};
			expect(killedAudit.err).toBe("stream_failed:timeout_role_only");
			expect(receiptOf(killedAudit).terminal).toBe(
				"upstream_deadline_role_only",
			);
			// listed group: the 30s override keeps the same stall ALIVE past
			// the global deadline — the wire honored the scoped budget
			const alive = await app.fetch(
				new Request(`${listed.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "glm-5.3", stream: true }),
				}),
			);
			expect(alive.status).toBe(200);
			const reader = alive.body?.getReader();
			expect(reader).toBeDefined();
			const first = await reader?.read(); // the role frame delivers
			expect(first?.done).toBe(false);
			// hold past the global deadline — the override must keep it open.
			// The alive leg's audit ROW exists from admission (err null); the
			// proof is that NO second deadline failure banked in the window.
			await Bun.sleep(700);
			const deadlineKills = deps.ledger
				.auditRows()
				.filter((r) => r.err === "stream_failed:timeout_role_only");
			expect(deadlineKills.length).toBe(1); // only the unlisted group died
			await reader?.cancel("proof done");
			await Bun.sleep(20);
		} finally {
			listed.close();
			unlisted.close();
		}
	}, 30_000);
});
