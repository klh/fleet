import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W1068 (owner doctrine 2026-10-20): the cloud leg defaults to MAX throughput
// — the only throttle is REACTIVE to upstream signals. A complex-shaped burst
// of 12 rides the escalate leg concurrently (no belt/buckle admission cap on
// the cloud hop), and any refusal must carry a GENUINE upstream Retry-After —
// never the local-shaped "at max in-flight" wall.
const home = mkdtempSync(join(tmpdir(), "w1068-burst-"));
mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
mkdirSync(join(home, ".claude-insights"), { recursive: true });
writeFileSync(
	join(home, ".claude", "local-llm", "prefs.json"),
	JSON.stringify({ allow_cloud: true, cost_speed: "balanced" }),
);

let localCalls = 0;
let gateCalls = 0;
let gateInflight = 0;
let gateMaxInflight = 0;
let gate429 = false;
let releaseLocal: (() => void) | undefined;
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
const gate = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch() {
		gateCalls++;
		gateInflight++;
		if (gateInflight > gateMaxInflight) gateMaxInflight = gateInflight;
		try {
			if (gate429)
				return Response.json(
					{
						error: { code: "1302", message: "z.ai request rate limit reached" },
					},
					{ status: 429, headers: { "retry-after": "3" } },
				);
			await Bun.sleep(50); // hold the hop so concurrency is observable
			return Response.json({ content: [{ type: "text", text: "cloud OK" }] });
		} finally {
			gateInflight--;
		}
	},
});
const port = (() => {
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const free = probe.port;
	probe.stop(true);
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
				BELT_UPSTREAM_KEY: "bksk_test-scoped-fake",
				BELT_UPSTREAM_BASE: `http://127.0.0.1:${local.port}`,
				BELT_PORT_CAPS: "8903:1", // the local reason tier stays capped at 1
				BELT_ESCALATE_URL: `http://127.0.0.1:${gate.port}`,
				BELT_ESCALATE_KEY: "bksk_test-scoped-key",
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
	gate.stop(true);
});

const BURST = 12;
const textOf = (body: unknown): string => {
	const c = (body as { content?: Array<{ text?: string }> }).content;
	return (c ?? [])
		.map((b) => b.text ?? "")
		.join("")
		.trim();
};
const post = (traceId: string) =>
	fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer bksk_test-scoped-fake",
			traceparent: `00-${traceId}-aaaaaaaaaaaaaaaa-01`,
			"x-klh-request-id": `w1068-${traceId.slice(0, 8)}`,
		},
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 40,
			messages: [
				{
					role: "user",
					content:
						"Multi-step trade-off analysis of three migration plans, step by step, no code. Use a frontier cloud model — nothing local can serve this within the deadline.",
				},
			],
		}),
	});
const traceIds = (n: number, salt: string): string[] =>
	Array.from({ length: n }, (_, i) =>
		`${salt}${String(i).padStart(2, "0")}`.padEnd(32, "0"),
	);
const gateRows = (log: string, ids: string[]) =>
	log
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter(
			(row) =>
				row.event === "upstream_attempt" &&
				row.hop === "buckle-gate" &&
				ids.includes(String(row.trace_id)),
		);

test("healthy upstream: burst of 12 complex requests all ride the gate concurrently — zero local admission", async () => {
	const ids = traceIds(BURST, "1");
	const burst = ids.map((id) => post(id));
	const responses = await Promise.all(burst);
	expect(localCalls).toBe(0);
	expect(gateCalls).toBe(BURST);
	expect(gateMaxInflight).toBe(BURST);
	for (const res of responses) {
		expect(res.status).toBe(200);
		expect(textOf(await res.json())).toBe("cloud OK");
	}
	const log = readFileSync(
		join(home, ".claude-insights", "swarm-routing.log"),
		"utf8",
	);
	const rows = gateRows(log, ids);
	expect(rows.length).toBe(BURST);
	expect(rows.every((row) => row.status === 200)).toBe(true);
});

test("rate-limited upstream: every refusal carries the genuine z.ai Retry-After — zero local-shaped walls", async () => {
	const ids = traceIds(BURST, "2");
	gate429 = true;
	const burst = ids.map((id) => post(id));
	const statuses: number[] = [];
	let settled = 0;
	burst.forEach((p) => {
		p.then((res) => {
			statuses.push(res.status);
			settled++;
		});
	});
	// 11 refuse on the genuine upstream 429; the 12th parks in the capped
	// :8903 spill leg until the local fake is released below.
	for (let i = 0; i < 200 && settled < BURST - 1; i++) await Bun.sleep(25);
	expect(settled).toBe(BURST - 1);
	expect(statuses.every((s) => s === 429)).toBe(true);
	releaseLocal?.();
	expect(statuses.every((s) => s === 429)).toBe(true);
	for (const p of burst) {
		const r = await p;
		if (r.status !== 429) continue;
		expect(r.headers.get("retry-after")).toBe("3");
		expect(r.headers.get("x-klh-refusal")).toBe("upstream_rate_limit");
		const body = (await r.json()) as { error: { message: string } };
		expect(body.error.message).toContain("z.ai request rate limit reached");
		expect(body.error.message).not.toContain("at max in-flight");
	}
	const log = readFileSync(
		join(home, ".claude-insights", "swarm-routing.log"),
		"utf8",
	);
	const rows = gateRows(log, ids);
	// all 12 ATTEMPTED the cloud leg (cloud-first); every attempt hit the
	// genuine upstream 429 and none was invented locally.
	expect(rows.length).toBe(BURST);
	expect(
		rows.every((row) => row.status === 429 && row.retry_after_ms === 3000),
	).toBe(true);
	const spill = await Promise.all(burst);
	expect(spill.filter((r) => r.status === 200).length).toBe(1);
	expect(localCalls).toBe(1);
});
