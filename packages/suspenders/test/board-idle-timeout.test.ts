// test/board-idle-timeout.test.ts — W1114 (owner directive 2026-10-21): the
// board's Bun.serve carries NO HTTP idle timer on active agent paths —
// /api/orchestrate proposals run up to the application's own 130s client /
// 120s LLM deadline, and Bun's 10s default connection-idle must never cut
// the transport while the app waits. Proof: a REAL fleet-board.ts against a
// mock LLM that answers SLOWER than the default idle window (12s) still
// returns 200 to the client. The application deadlines are untouched —
// orch.ts AbortSignal.timeout(120_000) and the UI's 130s stand.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
// W1275.1: the hand-rolled board fixture moved to the shared kit —
// boardFixture(0, afterAll, { env }) pins the slow-mock LLM URL on top of
// the kit's hermetic dead-upstream defaults.
import { boardFixture, unusedPort } from "./helpers/board-fixture.ts";

// spawn-heavy suite: the mock holds 12s of socket silence past Bun's 10s
// default idle window — the 5s per-test default can never see it through
setDefaultTimeout(90_000);

// mock LLM: instant /models resolve, then a proposal that arrives after 12s
// of socket silence — 2s PAST Bun's 10s default idle cutoff
const MPORT = unusedPort();
const MB = `http://127.0.0.1:${String(MPORT)}`;
const PROPOSAL = {
	title: "slow but complete proposal",
	children: [
		{ title: "first child", brief: "scope one" },
		{ title: "second child", brief: "scope two" },
	],
};
// the board process and dirs are the kit's to clean up; the mock dies with
// the test process
Bun.serve({
	port: MPORT,
	fetch: async (req) => {
		const path = new URL(req.url).pathname;
		if (path === "/v1/models")
			return Response.json({ data: [{ id: "mock-slow" }] });
		if (path === "/v1/chat/completions") {
			await new Promise((r) => setTimeout(r, 12_000));
			return Response.json({
				choices: [
					{
						message: {
							content: `\`\`\`json\n${JSON.stringify(PROPOSAL)}\n\`\`\``,
						},
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		return new Response("no route", { status: 404 });
	},
});

const f = await boardFixture(0, afterAll, {
	env: {
		SUSPENDERS_LLM_URL: `${MB}/v1/chat/completions`,
		ORACLE_ROUTE_URL: "http://127.0.0.1:1/v1/chat/completions",
	},
});

describe("board transport: no idle cutoff on slow agent paths (W1114)", () => {
	test("a 12s LLM proposal (past Bun's 10s default idle) still returns 200", async () => {
		await f.waitUp(f.BASE);
		const r = await fetch(`${f.BASE}/api/orchestrate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": f.TOKEN,
			},
			body: JSON.stringify({ project: f.REPO, goal: "slow proposal please" }),
			// generous client ceiling — the mock answers at 12s, the app's own
			// 120s LLM deadline is never the thing under test here
			signal: AbortSignal.timeout(60_000),
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			ok: boolean;
			proposal?: { title?: string };
		};
		expect(body.ok).toBe(true);
		expect(body.proposal?.title).toContain("slow but complete");
	});
});
