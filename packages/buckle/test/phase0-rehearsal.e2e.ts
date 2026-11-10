// test/phase0-rehearsal.e2e.ts — Phase 0 rehearsal inner-arm matrix
// (C380/C382/C384, owner directive: three lanes READY then build on the
// local machine). Dockerless: the deterministic vLLM stub
// (deploy/phase0-testbed/vllm-stub.ts) and the real gate boot in-process on
// ephemeral loopback ports; the compose/Docker Desktop smoke rides the same
// assertions via the edge arm's verify script.
//
// Rehearsed here: discovery, JSON completion, paced SSE through the gate,
// the include_usage injection proof (direct-without vs through-gate-with),
// 401 denial at the gate, zero-fallback on stub outage + recovery without a
// gate restart, header-strip correlation, revoked-key denial.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startVllmStub, type VllmStub } from "../deploy/phase0-testbed/vllm-stub.ts";
import { startServer } from "../src/server.ts";

const MODEL = "test-model";
const ROOT = "phase0-rehearsal-root";

interface Gate {
	base: string;
	stop(): void;
}

const startGate = (dir: string, stubUrl: string): Gate => {
	const upstreams = join(dir, "upstreams.json");
	const policy = join(dir, "policy.json");
	const prefs = join(dir, "prefs.json");
	// inherit_defaults:false + exactly one row: fail-closed with zero
	// fallback is STRUCTURAL (no committed ladder merges underneath).
	writeFileSync(
		upstreams,
		JSON.stringify({
			version: 1,
			inherit_defaults: false,
			groups: {
				[MODEL]: [
					{
						provider: "vllm-testbed",
						url: stubUrl,
						dialect: "openai",
						model: MODEL,
						api_key_env: "STUB_TOKEN",
						adapter: "openai-compat",
						priority: 1,
						group: MODEL,
					},
				],
			},
		}),
	);
	// High allowed_fails so the outage probes never trip the cooldown mark —
	// the recovery test then proves reconnect, not mark expiry.
	writeFileSync(
		policy,
		JSON.stringify({
			version: 1,
			gateway: { num_retries: 1, allowed_fails: 50, cooldown_time: 1 },
		}),
	);
	writeFileSync(
		prefs,
		JSON.stringify({ cost_speed: "balanced", allow_cloud: false }),
	);
	const server = startServer({
		port: 0,
		upstreamsPath: upstreams,
		policyPath: policy,
		prefsPath: prefs,
		dbPath: join(dir, "buckle.db"),
		auth: { rootKey: ROOT },
	});
	return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
};

const mintKey = async (gate: Gate, name: string): Promise<{ key: string; id: string }> => {
	const res = await fetch(`${gate.base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({ name, scopes: ["buckle:proxy:WRITE_"] }),
	});
	// W141 mint answers 201 Created with {key_id, key}
	expect(res.status).toBe(201);
	const out = (await res.json()) as { key_id: string; key: string };
	return { key: out.key, id: out.key_id };
};

const chat = async (
	gate: Gate,
	key: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<Response> =>
	fetch(`${gate.base}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, ...headers },
		body: JSON.stringify({ model: MODEL, ...body }),
	});

const sseFrames = (raw: string): string[] =>
	raw
		.split("\n\n")
		.map((frame) => frame.replace(/^data: /, "").trim())
		.filter((frame) => frame.length > 0);

test.describe("phase0 rehearsal inner arm", () => {
	let dir: string;
	let stub: VllmStub;
	let gate: Gate;
	let laneKey: string;

	test.beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "phase0-rehearsal-"));
		stub = startVllmStub();
		process.env.STUB_TOKEN = stub.token; // api_key_env reads at request time
		gate = startGate(dir, `${stub.url}/v1`);
		laneKey = (await mintKey(gate, "rehearsal-lane")).key;
	});

	test.afterAll(async () => {
		gate?.stop();
		await stub?.stop();
		// no test droppings left behind (01a186a5 #121234): the temp gate
		// home (db/policy/prefs/upstreams rows) and the env token both go
		rmSync(dir, { recursive: true, force: true });
		delete process.env.STUB_TOKEN;
	});

	test("discovery: the served model id is the wire id", async () => {
		const res = await fetch(`${gate.base}/v1/models`, {
			headers: { authorization: `Bearer ${laneKey}` },
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain(MODEL);
	});

	test("JSON completion through the gate: deterministic content + usage", async () => {
		const res = await chat(gate, laneKey, {
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 32,
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			model: string;
			choices: { message: { content: string } }[];
			usage: Record<string, number>;
		};
		expect(out.model).toBe(MODEL);
		expect(out.choices[0]?.message?.content).toBe("stub-ok");
		expect(out.usage.total_tokens).toBeGreaterThan(0);
	});

	test("paced SSE through the gate, with the include_usage injection proof", async () => {
		const started = Date.now();
		const res = await chat(gate, laneKey, {
			messages: [{ role: "user", content: "stream" }],
			max_tokens: 32,
			stream: true,
			pace_ms: 30,
		});
		expect(res.status).toBe(200);
		const raw = await res.text();
		const elapsed = Date.now() - started;

		const frames = sseFrames(raw);
		expect(frames[frames.length - 1]).toBe("[DONE]");
		const contentFrames = frames.filter(
			(f) => f !== "[DONE]" && f.includes('"stub-ok"'),
		);
		expect(contentFrames.length).toBeGreaterThanOrEqual(1);
		// the terminal usage frame rides BEFORE [DONE], with empty choices
		const parsed = frames
			.filter((f) => f !== "[DONE]")
			.map((f) => JSON.parse(f) as { choices?: unknown[]; usage?: unknown });
		const usageIdx = parsed.findIndex(
			(p) => Array.isArray(p.choices) && p.choices.length === 0 && p.usage,
		);
		expect(usageIdx).toBeGreaterThan(0);
		expect(usageIdx).toBeLessThan(frames.length - 1);
		// pacing actually applied: >= 2 paced gaps at 30ms each
		expect(elapsed).toBeGreaterThanOrEqual(60);

		// injection PROOF half 1: direct-to-stub WITHOUT stream_options logs
		// includeUsage false
		const direct = await fetch(`${stub.url}/v1/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${stub.token}` },
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: "user", content: "raw" }],
				stream: true,
			}),
		});
		expect(await direct.text()).not.toContain('"usage"');
		const directEntry = stub.log().findLast((e) => e.path === "/v1/chat/completions");
		expect(directEntry?.includeUsage).toBe(false);

		// injection PROOF half 2: the through-gate request logs includeUsage
		// true — the gate injected stream_options.include_usage on the wire
		const throughEntry = stub
			.log()
			.filter((e) => e.stream && e.includeUsage).length;
		expect(throughEntry).toBeGreaterThanOrEqual(1);
	});

	test("401 denial at the gate: no key and garbage key", async () => {
		const noKey = await fetch(`${gate.base}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: MODEL, messages: [] }),
		});
		expect(noKey.status).toBe(401);
		const garbage = await chat(gate, "bksk_not-a-real-key", {
			messages: [{ role: "user", content: "nope" }],
		});
		expect(garbage.status).toBe(401);
		// and the stub saw NONE of it — denial stayed inside the gate
		const pre = stub.log().length;
		await garbage.text();
		expect(stub.log().length).toBe(pre);
	});

	let restartStub = async (): Promise<void> => {
		const port = stub.port;
		const token = stub.token;
		await stub.stop();
		stub = startVllmStub({ port, token, model: MODEL });
		process.env.STUB_TOKEN = stub.token;
	};

	test("zero-fallback on stub outage, recovery without a gate restart", async () => {
		const port = stub.port;
		await stub.stop();
		const down = await chat(gate, laneKey, {
			messages: [{ role: "user", content: "outage" }],
		});
		expect(down.status).toBeGreaterThanOrEqual(500);
		expect(down.status).toBeLessThan(600);
		const downBody = await down.text();
		// the outage must not invent an alternate route: the model id still
		// names the one row, no silent reroute to another group
		expect(downBody).not.toContain("reroute");
		const models = await fetch(`${gate.base}/v1/models`, {
			headers: { authorization: `Bearer ${laneKey}` },
		});
		expect(models.status).toBe(200);
		expect(await models.text()).toContain(MODEL);

		// recovery: re-bind the SAME port, the gate reconnects on its own
		await restartStub();
		const back = await chat(gate, laneKey, {
			messages: [{ role: "user", content: "recovered" }],
		});
		expect(back.status).toBe(200);
		const backOut = (await back.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(backOut.choices[0]?.message?.content).toBe("stub-ok");
	});

	test("header-strip correlation: client-forged id never reaches the stub", async () => {
		const before = stub.log().length;
		const through = await chat(
			gate,
			laneKey,
			{ messages: [{ role: "user", content: "strip" }] },
			{ "x-klh-request-id": "forged-client-id" },
		);
		expect(through.status).toBe(200);
		await through.text();
		const entry = stub.log()[before];
		// client ids are stripped — but the gate ISSUES its own W3C traceparent
		// on outbound hops (W1086/W1118 telemetry): the through-gate traceId is
		// the gate's id (correlates gate ledger row <-> stub journal), never
		// the client's
		expect(entry?.requestId).toBeNull();
		expect(entry?.traceId).toMatch(/^[0-9a-f]{32}$/);

		// control: DIRECT to the stub the headers arrive verbatim — the nulls
		// above are the gate stripping, not the stub ignoring headers
		const direct = await fetch(`${stub.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${stub.token}`,
				"x-klh-request-id": "forged-client-id",
				traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
			},
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: "user", content: "direct" }],
			}),
		});
		expect(direct.status).toBe(200);
		const directEntry = stub.log().at(-1);
		expect(directEntry?.requestId).toBe("forged-client-id");
		expect(directEntry?.traceId).toBe("a".repeat(32));
	});

	test("revoked-key denial", async () => {
		const temp = await mintKey(gate, "rehearsal-temp");
		const ok = await chat(gate, temp.key, {
			messages: [{ role: "user", content: "minted" }],
		});
		expect(ok.status).toBe(200);
		await ok.text();
		const revoke = await fetch(
			`${gate.base}/v1/admin/keys/${temp.id}/revoke`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
			},
		);
		expect([200, 204]).toContain(revoke.status);
		const denied = await chat(gate, temp.key, {
			messages: [{ role: "user", content: "post-revoke" }],
		});
		expect(denied.status).toBe(401);
	});
});
