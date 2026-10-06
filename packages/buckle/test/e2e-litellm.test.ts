// test/e2e-litellm.test.ts — W219.1 litellm-as-engine: the :4100 engine is
// a routing-ladder upstream row, BEHIND buckle's governance. A governed
// request to a litellm-backed group answers through the front with a full
// route_audit row; engine-down degrades along the ladder (fallback rung +
// cooldown benching) without ever bypassing the gate. The fixture upstream
// stands in for the real :4100 — tests never depend on the live engine
// (the real-engine verification runs separately, noted in the work item).
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { startMockUpstream, type MockUpstream } from "./mock.ts";

const ROOT = "buckle-litellm-root";

// The engine fixture enforces litellm's master_key: a row without
// api_key_env would 401 at the engine, never at the front.
const ENGINE_KEY = "litellm-master-key-fixture";
const PRIOR_LITELLM_KEY = process.env.LITELLM_KEY;
process.env.LITELLM_KEY = ENGINE_KEY;
afterAll(() => {
	if (PRIOR_LITELLM_KEY === undefined) delete process.env.LITELLM_KEY;
	else process.env.LITELLM_KEY = PRIOR_LITELLM_KEY;
});

// ─── fixtures ───────────────────────────────────────────────────────────────

const CHAT = "/v1/chat/completions";

/** A stand-in for the litellm proxy: OpenAI wire on
 *  /v1/chat/completions, master-key bearer auth, `model` echoed so the
 *  test pins the alias patch. mode "down" = the engine is unhealthy. */
async function startLitellmFixture(): Promise<{
	up: MockUpstream;
	mode: { down: boolean };
}> {
	const mode = { down: false };
	const up = await startMockUpstream((_req, body) => {
		if (_req.headers.get("authorization") !== `Bearer ${ENGINE_KEY}`)
			return Response.json(
				{ error: { message: "Unauthorized" } },
				{ status: 401 },
			);
		if (mode.down)
			return Response.json(
				{ error: { message: "engine down" } },
				{ status: 500 },
			);
		return Response.json({
			id: "engine-1",
			model: body?.model,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "engine says hi" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 3, completion_tokens: 4 },
		});
	});
	return { up, mode };
}

const chatCalls = (up: MockUpstream) => up.calls.filter((c) => c.path === CHAT);

// ─── harness ────────────────────────────────────────────────────────────────

interface EngineGate {
	base: string;
	dbPath: string;
	stop(): void;
}

/** One gate over a two-rung pool: the litellm engine row first, the direct
 *  swarm row second — the W219.1 posture under test. policy: 1 retry,
 *  allowed_fails 1, cooldown 60s (long enough to stay benched in-test). */
async function startEngineGate(
	engine: MockUpstream,
	direct: MockUpstream,
): Promise<EngineGate> {
	const dir = mkdtempSync(join(tmpdir(), "buckle-litellm-"));
	const upstreams = `${dir}/upstreams.yaml`;
	const policy = `${dir}/policy.yaml`;
	const prefs = `${dir}/prefs.json`;
	const dbPath = `${dir}/buckle.db`;
	await Bun.write(
		upstreams,
		`version: 1
groups:
  glm-5.3-flash:
    - url: ${engine.url}
      dialect: openai
      adapter: openai-compat
      model: zai-glm-5.3-flash
      api_key_env: LITELLM_KEY
    - url: ${direct.url}
      dialect: openai
      adapter: openai-compat
`,
	);
	await Bun.write(
		policy,
		`version: 1
gateway:
  num_retries: 1
  allowed_fails: 1
  cooldown_time: 60
`,
	);
	await Bun.write(
		prefs,
		JSON.stringify({ cost_speed: "balanced", allow_cloud: false }),
	);
	const server = startServer({
		port: 0,
		upstreamsPath: upstreams,
		policyPath: policy,
		prefsPath: prefs,
		dbPath,
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		dbPath,
		stop: () => server.stop(true),
	};
}

async function issueViaAdmin(
	base: string,
	body: Record<string, unknown>,
): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string; key_id: string };
	return { key: out.key, keyId: out.key_id };
}

/** The ledger flush timer is 5s; one wait past it lets a second connection
 *  see the committed route_audit rows on the shared db file. */
async function auditRowsOf(
	dbPath: string,
): Promise<Array<Record<string, unknown>>> {
	await Bun.sleep(5300);
	const db = new Database(dbPath);
	try {
		return db.query("SELECT * FROM route_audit ORDER BY ts").all() as Array<
			Record<unknown, unknown>
		> as Array<Record<string, unknown>>;
	} finally {
		db.close();
	}
}

// ─── the contract ───────────────────────────────────────────────────────────

describe("W219.1 litellm-as-engine", () => {
	test("engine answers behind the gate with full audit; down degrades by ladder; denials never reach it", async () => {
		const engine = await startLitellmFixture();
		const direct = await startMockUpstream(() =>
			Response.json({
				id: "direct-1",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "direct" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			}),
		);
		const gate = await startEngineGate(engine.up, direct);
		try {
			const { key } = await issueViaAdmin(gate.base, {
				name: "lane",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const { key: roKey } = await issueViaAdmin(gate.base, {
				name: "ro",
				scopes: ["buckle:proxy:READ_"],
			});
			const post = (token: string) =>
				fetch(`${gate.base}${CHAT}`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
				});

			// Phase 1 — engine up: the governed request rides the engine rung.
			const ok = await post(key);
			expect(ok.status).toBe(200);
			const body = (await ok.json()) as {
				id: string;
				choices: Array<{ message?: { content?: string } }>;
			};
			expect(body.id).toBe("engine-1");
			expect(body.choices[0]?.message?.content).toBe("engine says hi");
			expect(chatCalls(engine.up)).toHaveLength(1);
			const engineCall = chatCalls(engine.up)[0];
			expect(engineCall?.auth).toBe(`Bearer ${ENGINE_KEY}`);
			expect((engineCall?.body as { model?: string })?.model).toBe(
				"zai-glm-5.3-flash",
			);
			expect(chatCalls(direct)).toHaveLength(0);

			// Phase 2 — engine down: the walk falls to the direct rung and
			// benches the engine (allowed_fails 1) — governance untouched.
			engine.mode.down = true;
			const degraded = await post(key);
			expect(degraded.status).toBe(200);
			const degradedBody = (await degraded.json()) as { id: string };
			expect(degradedBody.id).toBe("direct-1");
			expect(chatCalls(engine.up)).toHaveLength(3); // phase-1 try + the rung's own retry, then benched
			expect(chatCalls(direct)).toHaveLength(1);

			// Phase 3 — the engine is benched (cooldown state), but the decision
			// view refreshes on a 5s tick: within the tick the walk still retries
			// the engine rung and still DELIVERS via the direct rung. The audit
			// row below pins the delivered target.
			const benched = await post(key);
			expect(benched.status).toBe(200);
			expect(chatCalls(direct)).toHaveLength(2);

			// Phase 4 — READ_ key: the gate denies BEFORE the ladder; the
			// engine sees nothing (denied audits too, W136 doctrine).
			const denied = await post(roKey);
			expect(denied.status).toBe(403);
			const deniedBody = (await denied.json()) as { code: string };
			expect(deniedBody.code).toBe("buckle.insufficient_scope");
			expect(chatCalls(engine.up)).toHaveLength(5);

			// The full route_audit story, committed on the shared db file.
			const rows = await auditRowsOf(gate.dbPath);
			expect(rows).toHaveLength(4);
			const [r1, r2, r3, r4] = rows as Array<
				Record<string, string | number | null>
			>;
			// phase 1: routed to the engine rung, model patched, ok
			expect(r1.decision).toBe("policy");
			expect(r1.target_port).toBe(engine.up.port);
			expect(r1.target_model).toBe("zai-glm-5.3-flash");
			expect(r1.status).toBe(200);
			expect(r1.ok).toBe(1);
			// phase 2/3: the audit row records the DECIDED head (W136); the
			// delivered direct rung is proven by the fixture counts above.
			expect(r2.decision).toBe("policy");
			expect(r2.target_port).toBe(engine.up.port);
			expect(r2.status).toBe(200);
			expect(r2.ok).toBe(1);
			expect(r3.target_port).toBe(engine.up.port);
			expect(r3.ok).toBe(1);
			// phase 4: the denial row (denied audits too)
			expect(r4.decision).toBe("denied");
			expect(r4.error_code).toBe("buckle.insufficient_scope");
			expect(r4.status).toBe(403);
		} finally {
			gate.stop();
			engine.up.close();
			direct.close();
		}
	}, 20_000);
});
