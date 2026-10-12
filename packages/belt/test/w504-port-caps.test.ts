// test/w504-port-caps.test.ts — per-provider request caps on the :4000
// router (W504): registry rows carry maxInflight for the big unified-memory
// backends, BELT_PORT_CAPS overrides per port, and a full port answers 429 +
// Retry-After (fall-through per the ladder; the router never queues).
// Unit-level against bin/admission.ts + bin/registry.ts; wire-level through a
// real shim subprocess against a gated stub (parity-test pattern).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAdmission,
	overloaded,
	parsePortCaps,
} from "../bin/admission.ts";
import { SPECIALISTS } from "../bin/registry.ts";

const SHIM = new URL("../bin/router-shim.ts", import.meta.url).pathname;

describe("W504 parsePortCaps", () => {
	test("parses port:cap pairs", () => {
		expect(parsePortCaps("8903:1,8901:2")).toEqual({ 8903: 1, 8901: 2 });
	});

	test("malformed and zero entries dropped, never fatal", () => {
		expect(parsePortCaps("x:9,8901:0,8902:abc,,8906:3")).toEqual({
			8906: 3,
		});
		expect(parsePortCaps(undefined)).toEqual({});
	});
});

describe("W504 per-port admission", () => {
	test("per-port cap binds before the global default; other ports unaffected", () => {
		const a = createAdmission(4, 2, { 8903: 2 });
		const r1 = a.tryAcquire(8903);
		const r2 = a.tryAcquire(8903);
		expect(r1).not.toBeNull();
		expect(r2).not.toBeNull();
		expect(a.tryAcquire(8903)).toBeNull();
		expect(a.inflight(8903)).toBe(2);
		// global default still governs unlisted ports
		expect(a.capOf(8902)).toBe(4);
		expect(a.tryAcquire(8902)).not.toBeNull();
	});

	test("release frees the per-port slot; release is idempotent", () => {
		const a = createAdmission(1, 1, { 8903: 1 });
		const r = a.tryAcquire(8903);
		expect(a.tryAcquire(8903)).toBeNull();
		r?.();
		r?.();
		expect(a.inflight(8903)).toBe(0);
		expect(a.tryAcquire(8903)).not.toBeNull();
	});

	test("429 message carries the per-port cap", async () => {
		const a = createAdmission(4, 3, { 8903: 1 });
		a.tryAcquire(8903);
		const res = await admit429(a);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("3");
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("at max in-flight (1)");
		expect(body.error.type).toBe("overloaded_error");
	});
});

const admit429 = async (a: ReturnType<typeof createAdmission>) =>
	overloaded(8903, a);

describe("W504 registry wiring", () => {
	test("the big backends carry maxInflight; small rows inherit the default", () => {
		const byPortRow = (port: number) =>
			SPECIALISTS.find((s) => s.port === port);
		expect(byPortRow(8903)?.maxInflight).toBe(2); // 35B reason
		expect(byPortRow(8901)?.maxInflight).toBe(2); // 30B code
		expect(byPortRow(8902)?.maxInflight).toBeUndefined(); // 4B extract
		expect(byPortRow(8906)?.maxInflight).toBeUndefined(); // 9B ondemand
	});
});

// ─── wire: real shim subprocess, BELT_PORT_CAPS over a gated stub ───
const stubCalls: number[] = [];
const gates: Array<() => void> = [];
const stub = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method !== "POST" || url.pathname !== "/v1/chat/completions")
			return Response.json({ error: "not found" }, { status: 404 });
		stubCalls.push(Date.now());
		await new Promise<void>((res) => gates.push(res));
		return Response.json({
			id: "s1",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "stub says hi" },
					finish_reason: "stop",
				},
			],
		});
	},
});

const HOME = mkdtempSync(join(tmpdir(), "w504-shim-home-"));
let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let BASE = "";

const findFreePort = (): number => {
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(null),
	});
	const p = s.port ?? 0;
	s.stop(true);
	return p;
};

const waitHealthy = async (): Promise<boolean> => {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`${BASE}/health`);
			if (r.ok) return true;
		} catch {
			// not bound yet
		}
		await Bun.sleep(100);
	}
	return false;
};

const post = (body: unknown): Promise<Response> =>
	fetch(`${BASE}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

beforeAll(async () => {
	const port = findFreePort();
	BASE = `http://127.0.0.1:${port}`;
	proc = Bun.spawn(["bun", SHIM], {
		env: {
			...process.env,
			BELT_ROUTER_PORT: String(port),
			BELT_UPSTREAM_BASE: `http://127.0.0.1:${stub.port}`,
			BELT_PORT_CAPS: "8902:1", // the SIMPLE tier routes here (parity-proven)
			HOME,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	expect(await waitHealthy()).toBe(true);
});

afterAll(() => {
	proc?.kill();
	stub.stop(true);
});

describe("W504 wire: full port falls through at the shim", () => {
	test("BELT_PORT_CAPS=8902:1 → concurrent overflow 429s with the port cap", async () => {
		const first = post({
			model: "claude-sonnet-4",
			max_tokens: 40,
			messages: [{ role: "user", content: "Reply with the word OK." }],
		});
		await Bun.sleep(300); // acquire the slot, reach the stub
		const over = await post({
			model: "claude-sonnet-4",
			max_tokens: 40,
			messages: [{ role: "user", content: "Reply OK." }],
		});
		expect(over.status).toBe(429);
		expect(over.headers.get("retry-after")).toBe("2");
		const body = (await over.json()) as { error: { message: string } };
		expect(body.error.message).toContain("at max in-flight (1)");
		for (const g of gates) g(); // drain; slot frees
		const done = await first;
		expect(done.status).toBe(200);
		expect(stubCalls.length).toBe(1);
		const third = post({
			model: "claude-sonnet-4",
			max_tokens: 40,
			messages: [{ role: "user", content: "Reply OK." }],
		});
		await Bun.sleep(300); // reach the stub again (gated)
		for (const g of gates) g();
		expect((await third).status).toBe(200);
	});
});
