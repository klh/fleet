// test/w746-upstream-storm.test.ts — W746 gateway timeout cascade: a buckle
// 5xx storm must not wedge the surface the board/coord plane polls. The
// upstream answers 500 to N concurrent proxy chats; every one must settle
// (no hang), /health must stay fast DURING the storm, and once the upstream
// recovers the next chat rides again — no leaked admission slot or budget
// row wedging the gate after the incident.
import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { startMockUpstream } from "./mock.ts";

const ROOT = "buckle-storm-root";
const CHAT_BODY = JSON.stringify({ model: "glm-5.3-flash", stream: false });

describe("W746 upstream 5xx storm", () => {
	test("concurrent 500s all settle; /health stays live; recovery rides again", async () => {
		let healthy = false;
		const upstream = await startMockUpstream(() =>
			healthy
				? Response.json({
						id: "ok",
						choices: [{ message: { role: "assistant", content: "hi" } }],
						usage: {},
					})
				: new Response(JSON.stringify({ error: "storm" }), { status: 500 }),
		);
		const cfg = `/tmp/buckle-storm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`;
		await Bun.write(
			`${cfg}`,
			`groups:\n  glm-5.3-flash:\n    - url: ${upstream.url}\n      dialect: openai\n`,
		);
		const server = startServer({
			port: 0,
			upstreamsPath: cfg,
			dbPath: ":memory:",
			auth: { rootKey: ROOT },
		});
		const base = `http://127.0.0.1:${server.port}`;
		const issued = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ name: "storm", scopes: ["buckle:proxy:WRITE_"] }),
		});
		const { key } = (await issued.json()) as { key: string };
		const chat = (): Promise<Response> =>
			fetch(`${base}/v1/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: CHAT_BODY,
			});
		// the incident: 30 concurrent chats into a 500-storm upstream
		const storm = Array.from({ length: 30 }, () => chat());
		// DURING the storm the probe surface must stay responsive — the
		// board/coord plane polls /health, never the proxied legs
		for (let i = 0; i < 5; i++) {
			const t0 = Date.now();
			const h = await fetch(`${base}/health`);
			expect(h.status).toBe(200);
			expect(Date.now() - t0).toBeLessThan(1_000);
			await Bun.sleep(120);
		}
		const settled = await Promise.all(storm);
		for (const r of settled) expect(r.status).toBeGreaterThanOrEqual(500);
		// recovery: no leaked slot/budget — the very next chat rides again
		healthy = true;
		const ok = await chat();
		expect(ok.status).toBe(200);
		server.stop(true);
		upstream.close();
	});
});
