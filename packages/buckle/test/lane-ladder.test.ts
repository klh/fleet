// test/lane-ladder.test.ts — W985: scoped /w/ lane keys walk the operator
// fallback ladder. The route walk is key-agnostic (auth bounds spend/audit,
// never routing): a scoped bksk_ key riding /w/<sid>/v1/messages must get
// 200 via the fallback rung when its pinned primary group is dead, and a
// fast 502 no_route naming the group when every rung of the walk is dead
// (the spawn-fast-fail shape dispatch parses).
import { afterAll, describe, expect, test } from "bun:test";
import { startMockUpstream } from "./mock.ts";
import {
	type GateServer,
	issueViaAdmin,
	ROOT,
	startGate as bootGate,
} from "./gate.ts";

/** A loopback port with no listener: ECONNREFUSED = the unreachable rung. */
function deadUrl(): string {
	const s = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(null),
	});
	const url = `http://127.0.0.1:${String(s.port)}`;
	s.stop(true);
	return url;
}

type Gate = GateServer;

async function startGate(
	dead: string,
	fallbackUrl: string | null,
): Promise<Gate> {
	const fallbackGroup =
		fallbackUrl === null
			? ""
			: `  fallback:\n    - url: ${fallbackUrl}\n      dialect: anthropic\n`;
	const ladder =
		fallbackUrl === null ? "" : `  fallbacks:\n    primary: [fallback]\n`;
	return bootGate({
		yaml: `groups:\n  primary:\n    - url: ${dead}\n      dialect: anthropic\n${fallbackGroup}`,
		policyYaml: `gateway:\n  num_retries: 0\n  allowed_fails: 1\n${ladder}`,
	});
}

async function mintScoped(base: string): Promise<string> {
	const { key } = await issueViaAdmin(base, {
		name: "lane-w985",
		scopes: ["buckle:proxy:WRITE_"],
	});
	return key;
}

const BODY = JSON.stringify({
	model: "primary",
	max_tokens: 16,
	messages: [{ role: "user", content: "hi" }],
});

function post(base: string, path: string, token: string): Promise<Response> {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: BODY,
	});
}

const mocks: Array<{ close(): void }> = [];
const gates: Gate[] = [];

afterAll(() => {
	for (const g of gates) g.stop();
	for (const m of mocks) m.close();
});

describe("scoped lane keys walk the operator ladder (W985)", () => {
	test("dead primary group + healthy fallback → 200 via fallback", async () => {
		const healthy = await startMockUpstream(() =>
			Response.json({
				id: "msg_ok",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		mocks.push(healthy);
		const gate = await startGate(deadUrl(), healthy.url);
		gates.push(gate);
		const key = await mintScoped(gate.base);
		const res = await post(gate.base, "/w/autow985/v1/messages", key);
		expect(res.status).toBe(200);
		expect(healthy.calls.length).toBeGreaterThan(0);
	});

	test("root key walks the same ladder (walk is key-agnostic)", async () => {
		const healthy = await startMockUpstream(() =>
			Response.json({
				id: "msg_ok",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		mocks.push(healthy);
		const gate = await startGate(deadUrl(), healthy.url);
		gates.push(gate);
		const res = await post(gate.base, "/v1/messages", ROOT);
		expect(res.status).toBe(200);
	});

	test("every rung dead → fast 502 no_route naming the group", async () => {
		const gate = await startGate(deadUrl(), null);
		gates.push(gate);
		const key = await mintScoped(gate.base);
		const t0 = Date.now();
		const res = await post(gate.base, "/w/autow985/v1/messages", key);
		const ms = Date.now() - t0;
		expect(res.status).toBe(502);
		const body = (await res.json()) as { code: string; detail: string };
		expect(body.code).toBe("no_route");
		expect(body.detail).toContain("primary");
		expect(ms).toBeLessThan(5000);
	});
});

describe("auth-failing rungs walk on (W987)", () => {
	test("leg1 answers 401, leg2 answers 200 → 200 via leg2", async () => {
		const authFail = await startMockUpstream(() =>
			Response.json(
				{ error: { message: "bad credentials", type: "authentication_error" } },
				{ status: 401 },
			),
		);
		const healthy = await startMockUpstream(() =>
			Response.json({
				id: "msg_ok",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		mocks.push(authFail, healthy);
		const gate = await startGateLegs(
			`groups:\n  primary:\n    - url: ${authFail.url}\n      dialect: anthropic\n    - url: ${healthy.url}\n      dialect: anthropic\n`,
		);
		gates.push(gate);
		const key = await mintScoped(gate.base);
		const res = await post(gate.base, "/w/autow987/v1/messages", key);
		expect(res.status).toBe(200);
	});

	test("every leg auth-fails → exhausted 502, no hang", async () => {
		const authFail = await startMockUpstream(() =>
			Response.json({ error: { message: "forbidden" } }, { status: 403 }),
		);
		mocks.push(authFail);
		const gate = await startGateLegs(
			`groups:\n  primary:\n    - url: ${authFail.url}\n      dialect: anthropic\n`,
		);
		gates.push(gate);
		const key = await mintScoped(gate.base);
		const res = await post(gate.base, "/w/autow987/v1/messages", key);
		expect(res.status).toBe(502);
	});
});

/** W987 gate with an explicit group yaml (multi-leg legs under test). */
async function startGateLegs(upstreamsYaml: string): Promise<Gate> {
	return bootGate({
		yaml: upstreamsYaml,
		policyYaml: `gateway:\n  num_retries: 1\n  allowed_fails: 3\n`,
	});
}
