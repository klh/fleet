// test/board-idle-timeout.test.ts — W1114 (owner directive 2026-10-21): the
// board's Bun.serve carries NO HTTP idle timer on active agent paths —
// /api/orchestrate proposals run up to the application's own 130s client /
// 120s LLM deadline, and Bun's 10s default connection-idle must never cut
// the transport while the app waits. Proof: a REAL fleet-board.ts against a
// mock LLM that answers SLOWER than the default idle window (12s) still
// returns 200 to the client. The application deadlines are untouched —
// orch.ts AbortSignal.timeout(120_000) and the UI's 130s stand.
import { waitUp } from "@klh/test-kit";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// spawn-heavy suite: the mock holds 12s of socket silence past Bun's 10s
// default idle window — the 5s per-test default can never see it through
setDefaultTimeout(90_000);
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unusedPort } from "./helpers/board-fixture.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-board-idle-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-boardrepo-idle-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const PORT = unusedPort();
const BASE = `http://127.0.0.1:${String(PORT)}`;
const bin = join(import.meta.dir, "..", "hooks", "bin");

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
const mock = Bun.serve({
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

const env: Record<string, string | undefined> = {
	...process.env,
	HOME,
	SUSPENDERS_LLM_URL: `${MB}/v1/chat/completions`,
	SUSPENDERS_MDNS: "0",
	SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
	SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
	SUSPENDERS_BELT_ENV: join(HOME, "absent-belt.env"),
	ORACLE_ROUTE_URL: "http://127.0.0.1:1/v1/chat/completions",
};
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;

const proc = Bun.spawn(
	["bun", join(bin, "fleet-board.ts"), "--port", String(PORT)],
	{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
);
let output = "";
const drain = async (stream: ReadableStream<Uint8Array>) => {
	for await (const chunk of stream)
		output = `${output}${new TextDecoder().decode(chunk)}`.slice(-16_384);
};
void drain(proc.stdout);
void drain(proc.stderr);

afterAll(async () => {
	proc.kill();
	await proc.exited;
	mock.stop(true);
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("board transport: no idle cutoff on slow agent paths (W1114)", () => {
	test("a 12s LLM proposal (past Bun's 10s default idle) still returns 200", async () => {
		await waitUp(`${BASE}/api/data`, { tries: 150 });
		const token = readFileSync(
			join(HOME, ".cache", "claude-governor", "write-token"),
			"utf8",
		).trim();
		const r = await fetch(`${BASE}/api/orchestrate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": token,
			},
			body: JSON.stringify({ project: REPO, goal: "slow proposal please" }),
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
