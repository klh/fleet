// W1294.16: ported 1:1 from e2e-outbound-guard.test.ts to @playwright/test (@api).
// test/e2e-outbound-guard.test.ts — W1257.1 synthetic regression: a
// deployment whose adapter-built outbound URL (post path_rewrite) hits the
// blocked general endpoint is refused INSIDE the gate — the mock upstream
// records ZERO calls, the ladder walks on to a healthy rung, and pool load
// fails closed on malformed guard config. Tests never touch the real Z.ai.
import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { startMockUpstream, type MockUpstream } from "./mock.ts";

test.describe({ tag: "@api" }, () => {
	const ROOT = "buckle-guard-root";

	const CHAT = "/v1/chat/completions";

	const CORRECTIONS = {
		anthropic: "https://api.z.ai/api/anthropic/v1/messages",
		openai: "https://api.z.ai/api/coding/paas/v4/chat/completions",
		responses: "https://api.z.ai/api/v1/responses",
	};

	// W1306: fixtures emit JSON — fleet config parses JSON-only (W1253), the
	// ported-from yaml literals were dead at the parser (the fixme family).
	const blockedRow = (url: string, paths = ["/api/paas/v4/"]) => ({
		url,
		dialect: "openai",
		adapter: "openai-compat",
		model: "glm-5.3-flash",
		api_key_env: "Z_AI_API_KEY",
		adapter_config: {
			path_rewrite: {
				"/v1/chat/completions": "/api/paas/v4/chat/completions",
			},
			blocked_outbound: { paths, corrections: CORRECTIONS },
		},
	});

	const healthyRow = (url: string) => ({
		url,
		dialect: "openai",
		adapter: "openai-compat",
		model: "glm-5.3-flash",
		api_key_env: "Z_AI_API_KEY",
	});

	const healthyMock = (): Promise<MockUpstream> =>
		startMockUpstream(() =>
			Response.json({
				id: "healthy-1",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "ok" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			}),
		);

	interface Gate {
		base: string;
		stop(): void;
	}

	async function startGate(rows: unknown[]): Promise<Gate> {
		const dir = mkdtempSync(join(tmpdir(), "buckle-guard-"));
		const upstreams = `${dir}/upstreams.yaml`;
		const policy = `${dir}/policy.yaml`;
		const prefs = `${dir}/prefs.json`;
		// W1306: JSON content (W1253 JSON-only parser) under the legacy .yaml
		// names — honored only while the content is JSON.
		await Bun.write(
			upstreams,
			JSON.stringify({
				version: 1,
				groups: { "glm-5.3-flash": rows },
			}),
		);
		await Bun.write(
			policy,
			JSON.stringify({
				version: 1,
				gateway: { num_retries: 1, allowed_fails: 1, cooldown_time: 60 },
			}),
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
			dbPath: `${dir}/buckle.db`,
			auth: { rootKey: ROOT },
		});
		return {
			base: `http://127.0.0.1:${server.port}`,
			stop: () => server.stop(true),
		};
	}

	async function issueKey(base: string): Promise<string> {
		const res = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ name: "lane", scopes: ["buckle:proxy:WRITE_"] }),
		});
		const out = (await res.json()) as { key: string };
		return out.key;
	}

	const post = (base: string, key: string, model: string) =>
		fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: JSON.stringify({ model, stream: false }),
		});

	test.describe("W1257.1 outbound guard E2E", () => {
		test("blocked rung: zero upstream calls, refusal inside the gate", async () => {
			const blocked = await startMockUpstream(() =>
				Response.json({ error: { message: "blocked" } }, { status: 500 }),
			);
			const gate = await startGate([blockedRow(blocked.url)]);
			try {
				const key = await issueKey(gate.base);
				const res = await post(gate.base, key, "glm-5.3-flash");
				expect(res.status).toBe(502);
				// the boot prewarm's GET /v1/models may probe the origin, but ZERO
				// inference calls ever ride the blocked path_rewrite
				expect(blocked.calls.filter((c) => c.path === CHAT)).toHaveLength(0);
			} finally {
				gate.stop();
				blocked.close();
			}
		}, 20_000);

		test("blocked rung + healthy rung: 200 via the healthy leg, zero blocked calls", async () => {
			const blocked = await startMockUpstream(() =>
				Response.json({ error: { message: "blocked" } }, { status: 500 }),
			);
			const healthy = await healthyMock();
			const gate = await startGate([
				blockedRow(blocked.url),
				healthyRow(healthy.url),
			]);
			try {
				const key = await issueKey(gate.base);
				const res = await post(gate.base, key, "glm-5.3-flash");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { id?: string };
				expect(body.id).toBe("healthy-1");
				expect(blocked.calls.filter((c) => c.path === CHAT)).toHaveLength(0);
				expect(
					healthy.calls.filter((c) => c.path === CHAT).length,
				).toBeGreaterThan(0);
			} finally {
				gate.stop();
				blocked.close();
				healthy.close();
			}
		}, 20_000);

		test("pool load fails closed on malformed guard config", async () => {
			// W1294.16: startGate rejects async — playwright's toThrow is
			// sync-only, so the rejection asserts via rejects.toThrow.
			await expect(
				startGate([blockedRow("https://api.z.ai", [])]),
			).rejects.toThrow();
		});
	});
});
