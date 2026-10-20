// test/lane-ladder.test.ts — W985: scoped /w/ lane keys walk the operator
// fallback ladder. The route walk is key-agnostic (auth bounds spend/audit,
// never routing): a scoped bksk_ key riding /w/<sid>/v1/messages must get
// 200 via the fallback rung when its pinned primary group is dead, and a
// fast 502 no_route naming the group when every rung of the walk is dead
// (the spawn-fast-fail shape dispatch parses).
import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { startMockUpstream } from "./mock.ts";

const ROOT = "buckle-test-root";

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

interface Gate {
	base: string;
	stop(): void;
}

async function startGate(
	dead: string,
	fallbackUrl: string | null,
): Promise<Gate> {
	const dir = `/tmp/buckle-ladder-${String(Date.now())}-${String(process.pid)}-${Math.random().toString(36).slice(2, 6)}`;
	const fallbackGroup =
		fallbackUrl === null
			? ""
			: `  fallback:\n    - url: ${fallbackUrl}\n      dialect: anthropic\n`;
	const ladder =
		fallbackUrl === null ? "" : `  fallbacks:\n    primary: [fallback]\n`;
	await Bun.write(
		`${dir}-upstreams.yaml`,
		`groups:\n  primary:\n    - url: ${dead}\n      dialect: anthropic\n${fallbackGroup}`,
	);
	await Bun.write(
		`${dir}-policy.yaml`,
		`gateway:\n  num_retries: 0\n  allowed_fails: 1\n${ladder}`,
	);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}-upstreams.yaml`,
		policyPath: `${dir}-policy.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${String(server.port)}`,
		stop: () => server.stop(true),
	};
}

async function mintScoped(base: string): Promise<string> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({
			name: "lane-w985",
			scopes: ["buckle:proxy:WRITE_"],
		}),
	});
	const out = (await res.json()) as { key: string };
	return out.key;
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
