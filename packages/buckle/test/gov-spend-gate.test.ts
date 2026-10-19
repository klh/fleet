// test/gov-spend-gate.test.ts — W843 bounded spend policy, e2e through a
// real Bun.serve gate on a scratch port: the team spend ceiling denies at
// admission even when every window limit is null (the skip must not strand
// the book), and GET /v1/admin/teams/report reads the per-team view back.
import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { startMockUpstream } from "./mock.ts";

const ROOT = "buckle-test-root";

async function startGate(upstreamUrl: string): Promise<{
	base: string;
	stop(): void;
}> {
	const dir = `/tmp/buckle-spend-gate-${Date.now()}-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	await Bun.write(
		`${dir}.yaml`,
		`groups:\n  glm-5.3-flash:\n    - url: ${upstreamUrl}\n      dialect: openai\n`,
	);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

async function issueViaAdmin(
	base: string,
	body: Record<string, unknown>,
): Promise<{ key: string }> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string };
	return { key: out.key };
}

const CHAT_BODY = JSON.stringify({ model: "glm-5.3-flash", stream: false });

const chat = (base: string, token: string): Promise<Response> =>
	fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: CHAT_BODY,
	});

describe("gate: W843 team spend ceiling and the per-team report", () => {
	test("team spend ceiling denies at admission (est tokens > ceiling) → 429", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate(upstream.url);
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
		const gate = await startGate(upstream.url);
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
