import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	freePort,
	scratchWorld,
	serveStub,
	waitUp,
} from "@klh/test-kit";

const { home, env, clean } = scratchWorld({ prefix: "w1074-router-" });
mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
mkdirSync(join(home, ".claude-insights"), { recursive: true });
writeFileSync(
	join(home, ".claude", "local-llm", "prefs.json"),
	JSON.stringify({ allow_cloud: true, cost_speed: "balanced" }),
);

let releaseLocal: (() => void) | undefined;
let localCalls = 0;
let cloudCalls = 0;
let cloudPreference: string | null = null;
const local = serveStub(async () => {
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
});
const cloud = serveStub((req) => {
	cloudCalls++;
	cloudPreference = req.headers.get("x-klh-prefer");
	return Response.json(
		{ error: { code: "1302", message: "z.ai request rate limit reached" } },
		{
			status: 429,
			headers: {
				"retry-after": "7",
				"x-klh-prefer":
					"v=1;source=default;directive=default;line=0;index=0;target=fake;can=absent",
				"x-litellm-call-id": req.headers.get("x-litellm-call-id") ?? "",
				"x-belt-rid": "gate-rid-1",
			},
		},
	);
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;

beforeAll(async () => {
	proc = Bun.spawn(
		["bun", new URL("../bin/router-shim.ts", import.meta.url).pathname],
		{
			env: {
				...env,
				BELT_ROUTER_PORT: String(port),
				BELT_UPSTREAM_KEY: "bksk_test-scoped-fake",
				BELT_UPSTREAM_BASE: `http://127.0.0.1:${local.port}`,
				BELT_PORT_CAPS: "8902:1",
				BELT_ESCALATE_URL: `http://127.0.0.1:${cloud.port}`,
				BELT_ESCALATE_KEY: "bksk_test-scoped-key",
			},
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	await waitUp(`${base}/health`);
});

afterAll(() => {
	releaseLocal?.();
	proc?.kill();
	local.close();
	cloud.close();
	clean();
});

const post = () =>
	fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer bksk_test-scoped-fake",
			traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
			"x-klh-request-id": "lane-request-1",
			"x-klh-prefer":
				"v=1;source=dotfile;directive=must;line=2;index=0;target=glm-5.3-flash;can=absent",
		},
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
	expect(refused.headers.get("x-klh-service")).toBe("belt");
	expect(refused.headers.get("x-klh-hop")).toBe("buckle-gate");
	expect(refused.headers.get("x-klh-refusal")).toBe("upstream_rate_limit");
	expect(refused.headers.get("x-klh-trace-id")).toBe(
		"11111111111111111111111111111111",
	);
	expect(refused.headers.get("x-klh-request-id")).toBe("lane-request-1");
	expect(refused.headers.get("x-klh-prefer")).toBe(cloudPreference);
	expect(cloudPreference).toContain("directive=must;line=2");
	expect(refused.headers.get("x-klh-upstream-status")).toBe("429");
	expect(refused.headers.get("x-klh-upstream-request-id")).toBe("gate-rid-1");
	expect(refused.headers.get("x-litellm-call-id")).toMatch(
		/^belt_11111111111111111111111111111111_[0-9a-f]{16}$/,
	);
	const body = (await refused.json()) as { error: { message: string } };
	expect(body.error.message).toContain("z.ai request rate limit reached");
	expect(body.error.message).not.toContain("at max in-flight");
	expect(cloudCalls).toBe(1);
	const recorded = readFileSync(
		join(home, ".claude-insights", "swarm-routing.log"),
		"utf8",
	);
	expect(recorded).not.toContain("Reply OK.");
	expect(recorded).not.toContain("test-scoped-key");
	const records = recorded
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	expect(
		records.some(
			(row) =>
				row.event === "upstream_attempt" &&
				row.hop === "buckle-gate" &&
				row.status === 429 &&
				row.trace_id === "11111111111111111111111111111111" &&
				row.upstream_rid === "gate-rid-1" &&
				row.retry_after_ms === 7000,
		),
	).toBe(true);
	releaseLocal?.();
	expect((await first).status).toBe(200);
});
