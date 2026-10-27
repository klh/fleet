import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { needsDemandStart, SPECIALISTS } from "../bin/registry.ts";
import {
	coldTimeoutMs,
	ensureAvailable,
	loadingRetryAfterMs,
} from "../bin/spawner.ts";
import {
	freePort,
	scratchWorld,
	serveStub,
	waitUp,
} from "../../test-kit/src/index.ts";

const reason = SPECIALISTS.find((row) => row.role === "reason");

test("minimal tier demand-starts a heavy registered resident", () => {
	if (!reason) throw new Error("reason registry row missing");
	const prior = process.env.BELT_TIER;
	try {
		process.env.BELT_TIER = "minimal";
		expect(needsDemandStart(reason)).toBe(true);
		process.env.BELT_TIER = "full";
		expect(needsDemandStart(reason)).toBe(false);
	} finally {
		if (prior === undefined) delete process.env.BELT_TIER;
		else process.env.BELT_TIER = prior;
	}
});

test("loading retry hint tracks remaining cold-load time and spreads re-probes", () => {
	if (!reason) throw new Error("reason registry row missing");
	const now = 1_000_000;
	const budget = coldTimeoutMs(reason);
	expect(loadingRetryAfterMs(reason, now, now, 0)).toBe(budget);
	expect(loadingRetryAfterMs(reason, now - 60_000, now, 0)).toBe(
		budget - 60_000,
	);
	expect(loadingRetryAfterMs(reason, now, now, 1)).toBeGreaterThan(budget);
	expect(loadingRetryAfterMs(reason, now - budget - 1_000, now, 0)).toBe(1_000);
});

test("four concurrent cold admissions refuse promptly with a shared retry hint", async () => {
	if (!reason) throw new Error("reason registry row missing");
	const coldPort = await freePort();
	const prior = process.env.BELT_DEMAND_WARMUP;
	process.env.BELT_DEMAND_WARMUP = "0";
	try {
		const started = performance.now();
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				ensureAvailable({ ...reason, port: coldPort as typeof reason.port }),
			),
		);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(results.every((r) => !r.up && !r.warming)).toBe(true);
		expect(results.every((r) => r.retryAfterMs >= 1_000)).toBe(true);
	} finally {
		if (prior === undefined) delete process.env.BELT_DEMAND_WARMUP;
		else process.env.BELT_DEMAND_WARMUP = prior;
	}
});

let rejectLocal = false;
let cloudCalls = 0;
const local = serveStub((req) => {
	if (new URL(req.url).pathname !== "/v1/chat/completions")
		return new Response("missing", { status: 404 });
	if (rejectLocal)
		return Response.json({ error: "unavailable" }, { status: 503 });
	return Response.json({
		choices: [
			{
				message: { role: "assistant", content: "local answer" },
				finish_reason: "stop",
			},
		],
	});
});
const cloud = serveStub(() => {
	cloudCalls++;
	return Response.json({ content: [{ type: "text", text: "cloud answer" }] });
});
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const { home, env, clean } = scratchWorld({ prefix: "w1091-router-" });
let router: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
	const configDir = join(home, ".claude", "local-llm");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "prefs.json"),
		JSON.stringify({
			allow_cloud: true,
			cost_speed: "balanced",
			kev: { enabled: false },
		}),
	);
	router = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("../bin/router-shim.ts", import.meta.url).pathname,
		],
		env: {
			...env,
			BELT_TIER: "minimal",
			BELT_ROUTER_PORT: String(port),
			BELT_UPSTREAM_BASE: `http://127.0.0.1:${local.port}`,
			BELT_ESCALATE_URL: `http://127.0.0.1:${cloud.port}`,
			BELT_ESCALATE_KEY: "fixture-key",
			BELT_RETRY_WAIT_CAP_MS: "20",
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	await waitUp(`${base}/health/liveness`, { tries: 100, intervalMs: 50 });
});

afterAll(() => {
	router?.kill();
	local.close();
	cloud.close();
	clean();
});

async function route(
	prompt: string,
): Promise<{ status: number; port?: number }> {
	const response = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "local-swarm",
			max_tokens: 32,
			messages: [{ role: "user", content: prompt }],
		}),
		signal: AbortSignal.timeout(10_000),
	});
	const body = (await response.json()) as { _routing?: { port?: number } };
	return { status: response.status, port: body._routing?.port };
}

test("local router answers SIMPLE and COMPLEX without a cloud hop", async () => {
	rejectLocal = false;
	expect(await route("Reply with only OK.")).toEqual({
		status: 200,
		port: 8902,
	});
	expect(
		await route(
			"Analyze the architectural tradeoffs and failure modes of a distributed transaction coordinator across multiple services with adversarial retries and partial network partitions.",
		),
	).toEqual({ status: 200, port: 8903 });
	expect(cloudCalls).toBe(0);
});

test("four simultaneous local failovers refuse without re-entering the cloud ladder", async () => {
	rejectLocal = true;
	const started = performance.now();
	const results = await Promise.all(
		Array.from({ length: 4 }, () =>
			route(
				"Analyze the architectural tradeoffs and failure modes of a distributed transaction coordinator across multiple services with adversarial retries and partial network partitions.",
			),
		),
	);
	expect(performance.now() - started).toBeLessThan(10_000);
	expect(results.every((result) => [429, 502].includes(result.status))).toBe(
		true,
	);
	expect(cloudCalls).toBe(0);
});
