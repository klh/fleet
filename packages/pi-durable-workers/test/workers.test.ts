import { describe, expect, test } from "bun:test";
import type { EntryRecord, HookApi, JsonValue, Message } from "@earendil-works/pi-durable";
import {
	ApprovalsDoc,
	BudgetDoc,
	WakeDoc,
	roundSignature,
	stableStringify,
	type ApprovalRequest,
	type ApprovalsState,
	type BudgetState,
	type WakeState,
} from "../src/docs.ts";
import { budgetBeforeRequest, counters, verdict, createFinishTool, DEFAULTS, MEMO_STEPS, MEMO_CALLS } from "../src/budget.ts";
import { doomAfterTools, doomBeforeTool, doomBeforeRequest, foldRound, DOOM_DEFAULTS } from "../src/doomloop.ts";
import { approvalsBeforeTool, createApprovalsWriter } from "../src/approvals.ts";
import { createAnnouncer } from "../src/announce.ts";

// ---------- fake HookApi (memo + entry + snapshot, enough for every unit hook) ----------
function fakeApi(docs: Record<string, unknown> = {}, entries: Record<string, EntryRecord> = {}) {
	const memos = new Map<string, JsonValue>();
	const pendingRaises: ApprovalRequest[] = [];
	const api = {
		conversationId: "conv-1",
		taskId: "task-1",
		memo: async (name: string, ...rest: unknown[]) => {
			if (rest.length <= 1) return memos.get(name);
			memos.set(name, rest[0] as JsonValue);
			return rest[0] as JsonValue;
		},
		entry: async (id: string) => entries[id],
		snapshot: async (_doc: { definition?: { kind?: string } }, _scope: string) => docs[_doc?.definition?.kind ?? ""],
	} as unknown as HookApi & { __memos: Map<string, JsonValue> };
	(api as unknown as { __memos: Map<string, JsonValue> }).__memos = memos;
	return { api, memos, pendingRaises, ctx: {} as never };
}

const assistantEntry = (calls: Array<{ name: string; args: Record<string, unknown> }>): EntryRecord => ({
	id: "a1" as never,
	conversationId: "conv-1" as never,
	kind: "assistant",
	model: [
		{
			role: "assistant",
			content: calls.map((c) => ({ type: "toolCall", id: `c-${c.name}`, name: c.name, arguments: c.args })),
			timestamp: Date.now(),
		} as unknown as Message,
	],
});

const resultEntry = (text: string): EntryRecord => ({
	id: "r1" as never,
	conversationId: "conv-1" as never,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", content: [{ type: "text", text }], timestamp: Date.now() } as unknown as Message],
});

// ---------- docs ----------
describe("docs", () => {
	test("stableStringify is key-sorted and deterministic", () => {
		expect(stableStringify({ b: 1, a: [2, { z: 3, y: 4 }] })).toBe(stableStringify({ a: [2, { y: 4, z: 3 }], b: 1 }));
	});
	test("roundSignature: same round → same signature; different result → different", () => {
		const s1 = roundSignature([{ name: "bash", args: { cmd: "ls" }, resultHead: "file.txt" }]);
		const s2 = roundSignature([{ name: "bash", args: { cmd: "ls" }, resultHead: "file.txt" }]);
		const s3 = roundSignature([{ name: "bash", args: { cmd: "ls" }, resultHead: "OTHER" }]);
		expect(s1).toBe(s2);
		expect(s1).not.toBe(s3);
	});
	test("initial states are honest", () => {
		const w = WakeDoc.definition.initial() as WakeState;
		const b = BudgetDoc.definition.initial() as BudgetState;
		const a = ApprovalsDoc.definition.initial() as ApprovalsState;
		expect(w.policies).toEqual([]);
		expect(b.startedAt).toBeGreaterThan(0);
		expect(b.finishedAt).toBeUndefined();
		expect(a.requests).toEqual([]);
		expect(a.requireFor).toEqual([]);
	});
});

// ---------- budget ----------
describe("budget", () => {
	test("counters read memos", async () => {
		const { api, memos, ctx } = fakeApi();
		memos.set(MEMO_STEPS, 3);
		memos.set(MEMO_CALLS, 7);
		const c = await counters(api, ctx);
		expect(c).toEqual({ steps: 3, toolCalls: 7 });
	});
	test("verdict ladder ok → warn → stop", () => {
		expect(verdict({ steps: 0, toolCalls: 0 }, 40, 200, 0.8)).toBe("ok");
		expect(verdict({ steps: 32, toolCalls: 0 }, 40, 200, 0.8)).toBe("warn");
		expect(verdict({ steps: 40, toolCalls: 0 }, 40, 200, 0.8)).toBe("stop");
		expect(verdict({ steps: 0, toolCalls: 200 }, 40, 200, 0.8)).toBe("stop");
	});
	test("beforeRequest: silent at ok, steer at warn, hard stop note at cap", async () => {
		const ctx = {} as never;
		const mk = (steps: number, calls: number) => fakeApi();
		{
			const { api } = mk(0, 0);
			const r = await budgetBeforeRequest({ messages: [] }, api, ctx);
			expect(r).toBeUndefined();
		}
		{
			const { api, memos } = mk(0, 0);
			memos.set(MEMO_STEPS, 34);
			const r = await budgetBeforeRequest({ messages: [] }, api, ctx);
			expect(r?.messages.length).toBe(1);
			expect(String((r?.messages[0] as { content: string }).content)).toContain("approaching cap");
		}
		{
			const { api, memos } = mk(0, 0);
			memos.set(MEMO_STEPS, 40);
			const r = await budgetBeforeRequest({ messages: [] }, api, ctx);
			expect(String((r?.messages[0] as { content: string }).content)).toContain("HARD CAP");
			expect(String((r?.messages[0] as { content: string }).content)).toContain("workers_finish");
		}
	});
	test("foldRound bumps memos (replay-safe counters)", async () => {
		const { api, memos, ctx } = fakeApi();
		await foldRound(api, 2, ctx);
		await foldRound(api, 1, ctx);
		expect(memos.get(MEMO_STEPS)).toBe(2);
		expect(memos.get(MEMO_CALLS)).toBe(3);
	});
	test("finish tool writes BudgetDoc + calls onFinish", async () => {
		let finished: { summary: string; success: boolean } | null = null;
		const doc: BudgetState = { startedAt: Date.now() };
		const tool = createFinishTool({ onFinish: async (f) => void (finished = f) });
		const api = {
			conversationId: "conv-1",
			commit: async (change: (tx: never) => Promise<void>) => {
				await change({
					doc: async () => doc,
				} as never);
			},
		} as never;
		const res = await (tool.execute as (a: never, api: never, ctx: never) => Promise<unknown>)(
			{ summary: "done", success: true },
			api,
			{} as never,
		) as { details: { finished: boolean } };
		expect(res.details.finished).toBe(true);
		expect(doc.finishReason).toBe("finish_tool");
		expect(finished?.success).toBe(true);
	});
});

// ---------- doom loop ----------
describe("doom loop", () => {
	const ctx = {} as never;
	async function rounds(api: HookApi, n: number): Promise<number[]> {
		const out: number[] = [];
		for (let i = 0; i < n; i++) {
			const r = await doomAfterTools("a1", ["r1"], api, ctx);
			out.push(r.repeats);
		}
		return out;
	}
	test("identical rounds escalate repeats", async () => {
		const { api } = fakeApi({}, { a1: assistantEntry([{ name: "bash", args: { cmd: "ls" } }]), r1: resultEntry("x") });
		expect(await rounds(api, 4)).toEqual([1, 2, 3, 4]);
	});
	test("changed round resets the counter", async () => {
		const entries = {
			a1: assistantEntry([{ name: "bash", args: { cmd: "ls" } }]),
			r1: resultEntry("x"),
		};
		const { api, memos } = fakeApi({}, entries);
		await rounds(api, 3);
		entries.r1 = resultEntry("CHANGED");
		const r = await doomAfterTools("a1", ["r1"], api, ctx);
		expect(r.repeats).toBe(1);
		expect(memos.get("klh.workers.doom.repeat")).toBe(1);
	});
	test("beforeTool blocks at block rung, not before", async () => {
		const { api, memos } = fakeApi();
		memos.set("klh.workers.doom.lastSig", "abc" as JsonValue);
		memos.set("klh.workers.doom.repeat", DOOM_DEFAULTS.block - 1);
		expect((await doomBeforeTool({ name: "bash" }, api, ctx))?.block).toBeUndefined();
		memos.set("klh.workers.doom.repeat", DOOM_DEFAULTS.block);
		expect((await doomBeforeTool({ name: "bash" }, api, ctx))?.block).toContain("Blocked");
		memos.set("klh.workers.doom.repeat", DOOM_DEFAULTS.stop);
		expect((await doomBeforeTool({ name: "bash" }, api, ctx))?.block).toBeUndefined(); // stop rung: request-side
	});
	test("beforeRequest: observe note at 2, stop note at 6", async () => {
		const { api, memos } = fakeApi();
		expect(await doomBeforeRequest({ messages: [] }, api, ctx)).toBeUndefined();
		memos.set("klh.workers.doom.repeat", DOOM_DEFAULTS.observe);
		const obs = await doomBeforeRequest({ messages: [] }, api, ctx);
		expect(String((obs?.messages[0] as { content: string }).content)).toContain("observed");
		memos.set("klh.workers.doom.repeat", DOOM_DEFAULTS.stop);
		const stop = await doomBeforeRequest({ messages: [] }, api, ctx);
		expect(String((stop?.messages[0] as { content: string }).content)).toContain("workers_finish");
	});
});

// ---------- approvals ----------
describe("approvals", () => {
	const ctx = {} as never;
	test("no requireFor → no block", async () => {
		const state: ApprovalsState = { requests: [], requireFor: [] };
		const { api } = fakeApi({ "klh.workers.approvals": state });
		expect(await approvalsBeforeTool({ name: "bash", arguments: {} }, api, ctx)).toBeUndefined();
	});
	test("requireFor match without approval → block + pending raised", async () => {
		const state: ApprovalsState = { requests: [], requireFor: ["bash"] };
		const { api, pendingRaises } = fakeApi({ "klh.workers.approvals": state });
		const r = await approvalsBeforeTool({ name: "bash", arguments: { cmd: "rm" } }, api, ctx, (req) =>
			pendingRaises.push(req),
		);
		expect(r?.block).toContain("requires approval");
		expect(pendingRaises.length).toBe(1);
		expect(pendingRaises[0].status).toBe("pending");
	});
	test("approved record passes the gate", async () => {
		const args = { cmd: "rm" };
		const state: ApprovalsState = {
			requests: [
				{ id: "apr-1", tool: "bash", argsPreview: JSON.stringify(args), at: 1, status: "approved", decidedAt: 2 },
			],
			requireFor: ["bash"],
		};
		const { api } = fakeApi({ "klh.workers.approvals": state });
		expect(await approvalsBeforeTool({ name: "bash", arguments: args }, api, ctx)).toBeUndefined();
	});
	test("decide() flips status; unknown id rejected", async () => {
		const doc: { requests: ApprovalRequest[]; requireFor: string[] } = {
			requests: [{ id: "apr-9", tool: "bash", argsPreview: "{}", at: 1, status: "pending" }],
			requireFor: [],
		};
		const writer = createApprovalsWriter(
			async (change) => {
				await change(doc, {} as never);
			},
			async () => doc,
		);
		expect(await writer.decide("apr-nope", "approved", ctx)).toBe(false);
		expect(await writer.decide("apr-9", "denied", ctx)).toBe(true);
		expect(doc.requests[0].status).toBe("denied");
		const pend = await writer.pending(ctx);
		expect(pend).toEqual([]);
	});
});

// ---------- announce ----------
describe("announce", () => {
	test("posts W2886-contract body; rights empty until plane computes", async () => {
		const posts: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = (async (url: string | URL, init: RequestInit) => {
			posts.push({ url: String(url), init });
			return new Response("ok", { status: 200 });
		}) as typeof fetch;
		const a = createAnnouncer({
			hubUrl: "http://hub.local:4111",
			token: "t",
			conversationId: "conv-1",
			label: "worker-x",
			fetchImpl,
		});
		await a.beat("running", "W2901 build");
		expect(posts.length).toBe(1);
		expect(posts[0].url).toBe("http://hub.local:4111/workers/announce");
		const body = JSON.parse(String(posts[0].init.body)) as {
			workers: Array<{ sid: string; label: string; state: string; task: string; origin: { kind: string }; compute: { hub_id: string }; rights: unknown[]; reported_by?: string }>;
			asOf: number;
			errors: unknown[];
		};
		expect(body.errors).toEqual([]);
		expect(body.workers[0].sid).toBe("conv-1");
		expect(body.workers[0].label).toBe("worker-x");
		expect(body.workers[0].state).toBe("running");
		expect(body.workers[0].origin.kind).toBe("runner");
		expect(body.workers[0].compute.hub_id).toBe("hub.local:4111");
		expect(body.workers[0].rights).toEqual([]); // plane computes; never fabricated
		a.stop();
	});
	test("hub-dark: post fails, backoff grows, announce never throws", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts += 1;
			throw new Error("hub dark");
		}) as typeof fetch;
		const a = createAnnouncer({
			hubUrl: "http://hub.local:4111",
			conversationId: "conv-1",
			label: "w",
			everyS: 3600, // no retry within the test window
			fetchImpl,
		});
		await a.beat("running", "task");
		expect(attempts).toBe(1);
		a.stop();
	});
});

// ---------- defaults ----------
describe("defaults", () => {
	test("OpenRouter port defaults", () => {
		expect(DEFAULTS).toEqual({ maxSteps: 40, maxToolCalls: 200, warnAtFraction: 0.8 });
		expect(DOOM_DEFAULTS).toEqual({ observe: 2, block: 3, stop: 6 });
	});
});
