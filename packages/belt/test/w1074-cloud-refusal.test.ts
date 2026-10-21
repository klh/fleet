import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "w1074-router-"));
mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
writeFileSync(
	join(home, ".claude", "local-llm", "prefs.json"),
	JSON.stringify({ allow_cloud: true, cost_speed: "balanced" }),
);

let releaseLocal: (() => void) | undefined;
let localCalls = 0;
let cloudCalls = 0;
const local = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch() {
		localCalls++;
		await new Promise<void>((resolve) => {
			releaseLocal = resolve;
		});
		return Response.json({
			choices: [
				{
					message: { role: "assistant", content: "local OK" },
					finish_reason: "stop",
				},
			],
		});
	},
});
const cloud = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch() {
		cloudCalls++;
		return Response.json(
			{ error: { code: "1302", message: "z.ai request rate limit reached" } },
			{ status: 429, headers: { "retry-after": "7" } },
		);
	},
});

const port = (() => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const free = server.port;
	server.stop(true);
	return free;
})();
const base = `http://127.0.0.1:${port}`;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;

beforeAll(async () => {
	proc = Bun.spawn(
		["bun", new URL("../bin/router-shim.ts", import.meta.url).pathname],
		{
			env: {
				...process.env,
				HOME: home,
				BELT_ROUTER_PORT: String(port),
				BELT_UPSTREAM_BASE: `http://127.0.0.1:${local.port}`,
				BELT_PORT_CAPS: "8902:1",
				BELT_ESCALATE_URL: `http://127.0.0.1:${cloud.port}`,
				BELT_ESCALATE_KEY: "test-scoped-key",
			},
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`${base}/health`)).ok) return;
		} catch {
			// Waiting for the child to bind.
		}
		await Bun.sleep(50);
	}
	throw new Error("router did not start");
});

afterAll(() => {
	releaseLocal?.();
	proc?.kill();
	local.stop(true);
	cloud.stop(true);
});

const post = () =>
	fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 40,
			messages: [{ role: "user", content: "Reply OK." }],
		}),
	});

test("local slot overflow reports the attempted cloud refusal and its retry window", async () => {
	const first = post();
	for (let attempt = 0; attempt < 100 && localCalls === 0; attempt++)
		await Bun.sleep(20);
	expect(localCalls).toBe(1);
	const refused = await post();
	expect(refused.status).toBe(429);
	expect(refused.headers.get("retry-after")).toBe("7");
	const body = (await refused.json()) as { error: { message: string } };
	expect(body.error.message).toContain("z.ai request rate limit reached");
	expect(body.error.message).not.toContain("at max in-flight");
	expect(cloudCalls).toBe(1);
	releaseLocal?.();
	expect((await first).status).toBe(200);
});
