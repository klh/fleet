// test/gov-spend-gate.test.ts — W843 bounded spend policy, e2e through a
// real Bun.serve gate on a scratch port: the team spend ceiling denies at
// admission even when every window limit is null (the skip must not strand
// the book), and GET /v1/admin/teams/report reads the per-team view back.
import { describe, expect, test } from "bun:test";
import { startMockUpstream } from "./mock.ts";
import { chat, issueViaAdmin, ROOT, startGate } from "./gate.ts";

describe("gate: W843 team spend ceiling and the per-team report", () => {
	test("team spend ceiling denies at admission (est tokens > ceiling) → 429", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate({ upstreamUrl: upstream.url });
		await fetch(`${gate.base}/v1/admin/teams`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ team_id: "capped", spend_ceiling: 1 }),
		});
		const { key } = await issueViaAdmin(gate.base, {
			name: "cappedkey",
			team: "capped",
			scopes: ["buckle:proxy:WRITE_"],
		});
		// no rpm/tpm anywhere — only the spend ceiling bounds this key, so
		// the null-window skip must not strand the book
		const res = await chat(gate.base, key);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).not.toBeNull();
		gate.stop();
		upstream.close();
	});

	test("GET /v1/admin/teams/report reads back ceilings, members, windows, spend", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "x",
				choices: [],
				usage: { prompt_tokens: 10, completion_tokens: 20 },
			}),
		);
		const gate = await startGate({ upstreamUrl: upstream.url });
		await fetch(`${gate.base}/v1/admin/teams`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ team_id: "ops", spend_ceiling: 100000 }),
		});
		const { key } = await issueViaAdmin(gate.base, {
			name: "opskey",
			team: "ops",
			scopes: ["buckle:proxy:WRITE_"],
		});
		expect((await chat(gate.base, key)).status).toBe(200);
		const res = await fetch(`${gate.base}/v1/admin/teams/report`, {
			headers: { authorization: `Bearer ${ROOT}` },
		});
		const out = (await res.json()) as {
			teams: Array<Record<string, unknown>>;
		};
		const ops = out.teams.find((t) => t.team_id === "ops");
		if (!ops) throw new Error("ops team missing from the report");
		expect(ops.members).toBe(1);
		expect(ops.spend_ceiling).toBe(100000);
		// book errs high: the admission estimate + the settled real usage
		expect(Number(ops.spend_used_tok)).toBeGreaterThan(0);
		expect(Array.isArray(ops.windows)).toBe(true);
		expect((ops.windows as unknown[]).length).toBeGreaterThan(0);
		gate.stop();
		upstream.close();
	});
});

// W1118: the bounded ingress body reader guards EVERY body path — a
// stalled admin POST body must 408 under the shared deadline, proving
// readBoundedJson owns the read (never an unbounded req.json() buffer).
describe("gate: W1118 bounded ingress on the secondary body paths", () => {
	test("stalled admin body answers 408, not an unbounded read", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate({
			upstreamUrl: upstream.url,
			ingressBodyTimeoutMs: 100,
		});
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode('{"team_id":"ops","name":'),
				);
			},
		});
		const res = await fetch(`${gate.base}/v1/admin/teams`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body,
			duplex: "half",
		});
		expect(res.status).toBe(408);
		gate.stop();
		upstream.close();
	}, 5_000);
});
