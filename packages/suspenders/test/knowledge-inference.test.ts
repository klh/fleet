// knowledge-inference.test.ts — W1229: the lifecycle transport kit. Budget
// admission (rpm ring + concurrency), W3C traceparent shape, the chat wire
// contract (scoped bksk_ key, hint, model, max_tokens clamp), batched
// embeddings, the write-behind flush barrier, and the distill client riding
// the transport.
import { describe, expect, test } from "bun:test";
import { BuckleDistillClient } from "../hooks/lib/knowledge-ports.ts";
import {
	type LifecycleFetch,
	LifecycleInference,
	lifecycleTraceparent,
	MemoryBudget,
	memoryLimits,
	MemoryWrites,
} from "../hooks/lib/knowledge-inference.ts";

const ENV_KEYS = ["SUSPENDERS_BUCKLE_URL", "SUSPENDERS_BUCKLE_TOKEN"] as const;

function saveEnv(): Record<string, string | undefined> {
	const saved: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

const AUTH_ENV = {
	SUSPENDERS_BUCKLE_URL: "http://front.test:4101",
	SUSPENDERS_BUCKLE_TOKEN: "bksk_w1229_test",
} as const;

interface StubCall {
	url: string;
	init: RequestInit;
}

// chat wire: capture the request, answer one openai-shaped chat response
function chatStub(ok = true): {
	fetch: LifecycleFetch;
	calls: StubCall[];
} {
	const calls: StubCall[] = [];
	const fetch: LifecycleFetch = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		if (!ok) return new Response("boom", { status: 500 });
		return Response.json({
			choices: [{ message: { content: "[]" } }],
			usage: { prompt_tokens: 11, completion_tokens: 3 },
		});
	};
	return { fetch, calls };
}

// embeddings wire: answer index-ordered vectors
function embedStub(): { fetch: LifecycleFetch; calls: StubCall[] } {
	const calls: StubCall[] = [];
	const fetch: LifecycleFetch = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		const body = JSON.parse(String(init?.body)) as { input: string[] };
		return Response.json({
			data: body.input.map((t, i) => ({ index: i, embedding: [t.length, i] })),
		});
	};
	return { fetch, calls };
}

// budget-light limits for in-process tests (bounded admit wait)
const TEST_LIMITS = (over: Partial<ReturnType<typeof memoryLimits>> = {}) => ({
	...memoryLimits({}),
	waitMs: 150,
	...over,
});

describe("memoryLimits", () => {
	test("defaults", () => {
		const l = memoryLimits({});
		expect(l.rpm).toBe(20);
		expect(l.concurrency).toBe(2);
		expect(l.maxTokens).toBe(1600);
		expect(l.embedUrl).toBe("http://127.0.0.1:8907/v1/embeddings");
		expect(l.embedBatch).toBe(32);
	});

	test("parses overrides and clamps over-cap values", () => {
		const l = memoryLimits({
			SUSPENDERS_MEMORY_RPM: "7",
			SUSPENDERS_MEMORY_EMBED_BATCH: "999",
			SUSPENDERS_MEMORY_EMBED_URL: "http://hub.test:9/v1/embeddings",
			SUSPENDERS_MEMORY_EMBED_TOKEN: "hub-tok",
		});
		expect(l.rpm).toBe(7);
		expect(l.embedBatch).toBe(128);
		expect(l.embedToken).toBe("hub-tok");
	});

	test("empty string counts as absent", () => {
		expect(memoryLimits({ SUSPENDERS_MEMORY_RPM: "" }).rpm).toBe(20);
	});
});

describe("lifecycleTraceparent", () => {
	test("W3C form", () => {
		for (let i = 0; i < 5; i++)
			expect(lifecycleTraceparent()).toMatch(
				/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
			);
	});
});

describe("MemoryBudget", () => {
	test("rpm ring admits then refuses until the window slides", () => {
		let t = 1_000_000;
		const b = new MemoryBudget(2, 4, () => t);
		expect(b.tryAdmit()).toBe(true);
		expect(b.tryAdmit()).toBe(true);
		expect(b.tryAdmit()).toBe(false); // rpm 2 spent
		t += 61_000;
		expect(b.tryAdmit()).toBe(true); // window slid
	});

	test("concurrency caps in-flight, release frees a slot", () => {
		const t = 1_000_000;
		const b = new MemoryBudget(10, 1, () => t);
		expect(b.tryAdmit()).toBe(true);
		expect(b.tryAdmit()).toBe(false); // in-flight 1 = cap
		b.release();
		expect(b.tryAdmit()).toBe(true);
	});
});

describe("LifecycleInference.chat", () => {
	test("rides the scoped key with budget + traceparent + hint", async () => {
		const saved = saveEnv();
		try {
			process.env.SUSPENDERS_BUCKLE_URL = AUTH_ENV.SUSPENDERS_BUCKLE_URL;
			process.env.SUSPENDERS_BUCKLE_TOKEN = AUTH_ENV.SUSPENDERS_BUCKLE_TOKEN;
			const s = chatStub();
			const inf = new LifecycleInference({
				limits: TEST_LIMITS(),
				fetch: s.fetch,
			});
			const out = await inf.chat({
				kind: "consolidate",
				system: "sys",
				user: "usr",
			});
			expect(out.content).toBe("[]");
			expect(out.inTok).toBe(11);
			expect(out.traceId).toMatch(/^[0-9a-f]{32}$/);
			const call = s.calls[0];
			if (!call) throw new Error("no wire call");
			expect(call.url).toBe("http://front.test:4101/v1/chat/completions");
			const h = new Headers(call.init.headers);
			expect(h.get("authorization")).toBe("Bearer bksk_w1229_test");
			expect(h.get("x-belt-hint")).toBe("knowledge lifecycle: consolidate");
		} finally {
			restoreEnv(saved);
		}
	});

	test("refuses after a bounded wait when the rpm window is spent", async () => {
		const saved = saveEnv();
		try {
			process.env.SUSPENDERS_BUCKLE_URL = AUTH_ENV.SUSPENDERS_BUCKLE_URL;
			process.env.SUSPENDERS_BUCKLE_TOKEN = AUTH_ENV.SUSPENDERS_BUCKLE_TOKEN;
			const s = chatStub();
			const inf = new LifecycleInference({
				limits: TEST_LIMITS({ rpm: 1 }),
				fetch: s.fetch,
			});
			await inf.chat({ kind: "t", system: "s", user: "u" });
			await expect(
				inf.chat({ kind: "t", system: "s", user: "u" }),
			).rejects.toThrow("budget exhausted");
			expect(s.calls.length).toBe(1); // second call never hit the wire
		} finally {
			restoreEnv(saved);
		}
	});

	test("hint override + max_tokens clamp ride the wire", async () => {
		const saved = saveEnv();
		try {
			process.env.SUSPENDERS_BUCKLE_URL = AUTH_ENV.SUSPENDERS_BUCKLE_URL;
			process.env.SUSPENDERS_BUCKLE_TOKEN = AUTH_ENV.SUSPENDERS_BUCKLE_TOKEN;
			const s = chatStub();
			const inf = new LifecycleInference({
				limits: TEST_LIMITS({ maxTokens: 512 }),
				fetch: s.fetch,
			});
			await inf.chat({
				kind: "distill",
				hint: "prefer local distill reasoning",
				maxTokens: 9000,
				system: "s",
				user: "u",
			});
			const call = s.calls[0];
			if (!call) throw new Error("no wire call");
			expect(new Headers(call.init.headers).get("x-belt-hint")).toBe(
				"prefer local distill reasoning",
			);
			expect(JSON.parse(String(call.init.body)).max_tokens).toBe(512);
		} finally {
			restoreEnv(saved);
		}
	});

	test("non-ok upstream surfaces the status", async () => {
		const saved = saveEnv();
		try {
			process.env.SUSPENDERS_BUCKLE_URL = AUTH_ENV.SUSPENDERS_BUCKLE_URL;
			process.env.SUSPENDERS_BUCKLE_TOKEN = AUTH_ENV.SUSPENDERS_BUCKLE_TOKEN;
			const bad = new LifecycleInference({
				limits: TEST_LIMITS(),
				fetch: chatStub(false).fetch,
			});
			await expect(
				bad.chat({ kind: "t", system: "s", user: "u" }),
			).rejects.toThrow("Buckle lifecycle route 500");
		} finally {
			restoreEnv(saved);
		}
	});
});

describe("LifecycleInference.embed", () => {
	test("batches texts and preserves order", async () => {
		const s = embedStub();
		const inf = new LifecycleInference({
			limits: TEST_LIMITS({ embedBatch: 2 }),
			fetch: s.fetch,
		});
		const vecs = await inf.embed(["aa", "bbb", "cccc", "dd", "e"]);
		expect(s.calls.length).toBe(3); // 2 + 2 + 1
		// stub vectors are [len, per-batch index] — order across batches holds
		expect(vecs).toEqual([
			[2, 0],
			[3, 1],
			[4, 0],
			[2, 1],
			[1, 0],
		]);
		const body = JSON.parse(String(s.calls[0]?.init.body ?? "{}"));
		expect(body.model).toBe("local-embed");
		expect(body.input).toEqual(["aa", "bbb"]);
	});

	test("empty input makes zero calls", async () => {
		const s = embedStub();
		const inf = new LifecycleInference({
			limits: TEST_LIMITS(),
			fetch: s.fetch,
		});
		expect(await inf.embed([])).toEqual([]);
		expect(s.calls.length).toBe(0);
	});

	test("embed token rides as bearer when configured", async () => {
		const s = embedStub();
		const inf = new LifecycleInference({
			limits: TEST_LIMITS({
				embedToken: "hub-tok",
				embedUrl: "http://hub.test:9/v1/embeddings",
			}),
			fetch: s.fetch,
		});
		await inf.embed(["x"]);
		const call = s.calls[0];
		if (!call) throw new Error("no wire call");
		expect(call.url).toBe("http://hub.test:9/v1/embeddings");
		expect(new Headers(call.init.headers).get("authorization")).toBe(
			"Bearer hub-tok",
		);
	});

	test("short batch is an error", async () => {
		const s = embedStub();
		s.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			return Response.json({
				data: body.input.slice(0, 1).map((t, i) => ({
					index: i,
					embedding: [t.length],
				})),
			});
		};
		const inf = new LifecycleInference({
			limits: TEST_LIMITS(),
			fetch: s.fetch,
		});
		await expect(inf.embed(["a", "b"])).rejects.toThrow("batch short");
	});
});

describe("MemoryWrites", () => {
	test("pushes run async; flush is the wait-before-recall barrier", async () => {
		const w = new MemoryWrites();
		let ran = 0;
		let open = true;
		await w.push(async () => {
			while (open) await Bun.sleep(5);
			ran += 1;
		});
		expect(ran).toBe(0); // write-behind: nothing ran yet
		expect(w.pending()).toBe(1);
		open = false;
		const errs = await w.flush();
		expect(errs).toEqual([]);
		expect(ran).toBe(1);
	});

	test("flush surfaces op errors", async () => {
		const w = new MemoryWrites();
		await w.push(async () => {
			throw new Error("write failed");
		});
		const errs = await w.flush();
		expect(errs.length).toBe(1);
		expect(errs[0]?.message).toBe("write failed");
	});
});

describe("BuckleDistillClient rides the transport", () => {
	test("chat delegation keeps the W96 wire contract", async () => {
		const saved = saveEnv();
		const realFetch = globalThis.fetch;
		try {
			process.env.SUSPENDERS_BUCKLE_URL = AUTH_ENV.SUSPENDERS_BUCKLE_URL;
			process.env.SUSPENDERS_BUCKLE_TOKEN = AUTH_ENV.SUSPENDERS_BUCKLE_TOKEN;
			const s = chatStub();
			globalThis.fetch = s.fetch as typeof globalThis.fetch;
			const c = new BuckleDistillClient();
			const out = await c.distill("payload-w1229", {
				domain: "d",
				area: "a",
				codeOrigin: "c",
				originSid: "s",
			});
			expect(out).toEqual([]);
			const call = s.calls[0];
			if (!call) throw new Error("no wire call");
			const h = new Headers(call.init.headers);
			expect(h.get("authorization")).toBe("Bearer bksk_w1229_test");
			expect(h.get("x-belt-hint")).toBe("prefer local distill reasoning");
			expect(h.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
			const body = JSON.parse(String(call.init.body));
			expect(body.model).toBe("local-swarm");
			expect(body.max_tokens).toBe(1600);
		} finally {
			globalThis.fetch = realFetch;
			restoreEnv(saved);
		}
	});
});
