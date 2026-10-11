// test/e2e-harness.test.ts — W234: the docker e2e harness fixtures, proven
// WITHOUT docker (CI's plain test job has no daemon): the compose structure
// (text-level — no yaml dep in the plain test job), the stub tier's OpenAI
// wire contract, the lane executor's evidence contract, and the runner's
// root-key mint. The full chain itself is gated by the CI `docker-e2e` job.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

setDefaultTimeout(30_000);

const E2E = join(import.meta.dir, "..", "deploy", "e2e");
const MARKER = "e2e-stub-ok";

const read = (name: string): string => readFileSync(join(E2E, name), "utf8");

describe("W234 e2e harness (no-daemon fixtures)", () => {
	test("compose stands up the full chain, solo by default", () => {
		const compose = read("e2e-compose.yaml");
		for (const svc of [
			"buckle-hub:",
			"belt-stub:",
			"board-hub:",
			"store-hub:",
			"caddy:",
			"buckle-health:",
			"board-health:",
			"store-health:",
			"buckle-overlay:",
		]) {
			expect(compose).toContain(svc);
		}
		// solo default: exactly one profile-gated service — the overlay leg
		expect(compose.match(/profiles:/g)?.length).toBe(1);
		expect(compose).toContain('profiles: ["overlay"]');
		// bridge networking with loopback publishes (host mode never works on
		// all runners; hub-compose keeps host mode for the real hub tops)
		expect(compose).not.toContain("network_mode: host");
		expect(compose).toContain('"127.0.0.1:4111:4111"');
		expect(compose).toContain('"127.0.0.1:8902:8902"');
		// gate config + code bind law: env_file (fail-closed root key) and the
		// read-only $FLEET_DIR bind are load-bearing structure
		expect(compose).toContain("FLEET_DIR:?set FLEET_DIR");
		expect(compose).toContain("env_file");
		expect(compose).toContain("BUCKLE_UPSTREAMS:");
	});

	test("buckle ladder override walks the belt stub over the compose network", () => {
		const up = read("upstreams.e2e.yaml");
		expect(up.match(/http:\/\/belt-stub:8902/g)?.length).toBe(2);
		expect(up).not.toContain("127.0.0.1");
	});

	test("caddy front: catch-all + named .local site proxy the gate", () => {
		const caddy = read("Caddyfile.e2e");
		expect(caddy.match(/reverse_proxy buckle-hub:4111/g)?.length).toBe(2);
		expect(caddy).toContain("e2e-buckle.local:8080");
	});

	test("stub tier serves the OpenAI wire contract (json + sse)", async () => {
		// chosen port (not 0): the runner never parses the stub's stdout, and
		// reading a live server's stdout to EOF would deadlock the test
		const port = 20000 + Math.floor(Math.random() * 20000);
		const p = spawn(process.execPath, [join(E2E, "stub-tier.ts")], {
			env: { ...process.env, TIER_PORT: String(port) },
			stdout: "pipe",
		});
		let up = false;
		for (let i = 0; i < 50; i++) {
			try {
				const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
					signal: AbortSignal.timeout(1000),
				});
				if (r.ok) {
					up = true;
					break;
				}
			} catch {
				await Bun.sleep(200);
			}
		}
		expect(up).toBe(true);
		const base = `http://127.0.0.1:${port}`;
		const json = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "local-swarm", stream: false }),
		});
		const body = (await json.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		expect(json.status).toBe(200);
		expect(body.choices[0]?.message.content).toBe(MARKER);
		const sse = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "local-swarm", stream: true }),
		});
		const sseText = await sse.text();
		expect(sse.status).toBe(200);
		expect(sseText).toContain(MARKER);
		expect(sseText).toContain("[DONE]");
		await kill(p);
	});

	test("lane executor writes the dispatch evidence contract", async () => {
		// the fake lane front: buckle's /w/<sid> /v1/messages SSE shape.
		// chosen port: Bun.serve({port: 0}) keeps .port at 0 on this runtime,
		// so the assertion reads the evidence, not the reflect value
		const fport = 20000 + Math.floor(Math.random() * 20000);
		const front = Bun.serve({
			port: fport,
			fetch: () =>
				new Response(
					'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"e2e-stub-ok"}}\n\nevent: message_stop\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		const home = mkdtempSync(join(tmpdir(), "w234-exec-"));
		const evidencePath = join(home, "evidence.json");
		const p = spawn(process.execPath, [join(E2E, "lane-executor.ts")], {
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${fport}`,
				ANTHROPIC_AUTH_TOKEN: "bksk_w234_test",
				KLH_LANE_EVIDENCE: evidencePath,
				SUSPENDERS_HUB: "e2e-hub",
			},
			stdout: "pipe",
		});
		let evidence: Record<string, unknown> | null = null;
		for (let i = 0; i < 20; i++) {
			if (existsSync(evidencePath)) {
				evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<
					string,
					unknown
				>;
				break;
			}
			await Bun.sleep(500);
		}
		await kill(p);
		front.stop(true);
		rmSync(home, { recursive: true, force: true });
		expect(evidence).not.toBeNull();
		expect(evidence?.ok).toBe(true);
		expect(evidence?.status).toBe(200);
		expect(evidence?.base).toBe(`http://127.0.0.1:${fport}`);
		expect(String(evidence?.sample)).toContain(MARKER);
		expect(evidence?.hub).toBe("e2e-hub");
	});

	test("runner root-key mint: 0600 + idempotent", async () => {
		const { mintRootKey } = await import("../deploy/e2e/run-e2e.ts");
		const f = join(mkdtempSync(join(tmpdir(), "w234-mint-")), "buckle.env");
		const a = mintRootKey(f);
		const b = mintRootKey(f);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(f).mode & 0o777).toBe(0o600);
		rmSync(join(f, ".."), { recursive: true, force: true });
	});
});

/** reap a spawned stub + its stdout pipe reader */
async function kill(p: ReturnType<typeof spawn>): Promise<void> {
	p.kill();
	await Bun.sleep(100);
}
