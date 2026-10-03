// prompt-transform.test.ts — W270 orchestrate prompt transforms: condense
// determinism, enhance fallback, injection disclosure, secret redaction,
// preview→dispatch handoff.
import { describe, expect, test } from "bun:test";
import {
	condensePrompt,
	enhancePrompt,
	type Fetcher,
	holdPlan,
	PROMPT_DEFAULTS,
	preparePrompt,
	previewView,
	redactSecrets,
	resolvePromptSettings,
	takePlan,
} from "../hooks/board/prompt-transform.ts";
import { validateBoardSettings } from "../hooks/lib/board-config.ts";

const FLUFFY =
	"Hi there! Could you please just basically add a CSV export to the `tasks` table in hooks/board/data.ts? I would like you to make sure that it streams. I would like you to make sure that it streams. Thanks so much!";

describe("prompt condenser", () => {
	test("strips filler, keeps imperative verbs and technical terms", () => {
		const out = condensePrompt(FLUFFY);
		expect(out).toContain("add a CSV export");
		expect(out).toContain("`tasks`");
		expect(out).toContain("hooks/board/data.ts");
		expect(out).toContain("ensure it streams");
		for (const w of [
			"Hi",
			"please",
			"basically",
			"just",
			"Thanks",
			"Could you",
		])
			expect(out).not.toContain(w);
		expect(out.length).toBeLessThan(FLUFFY.length);
	});
	test("deterministic and idempotent", () => {
		const a = condensePrompt(FLUFFY);
		expect(condensePrompt(FLUFFY)).toBe(a);
		expect(condensePrompt(a)).toBe(a);
	});
	test("collapses repeated sentences and doubled words", () => {
		const out = condensePrompt("Fix the the bug. Fix the bug. Ship it!!!");
		expect(out).toBe("Fix the bug. Ship it!");
	});
	test("code fences, URLs, flags and dotted ids stay verbatim", () => {
		const src =
			"please run `bun test --bail` then just check https://example.com/just/really?x=1 and prompt.condense\n```ts\nconst just = 'please really';\n```";
		const out = condensePrompt(src);
		expect(out).toContain("`bun test --bail`");
		expect(out).toContain("https://example.com/just/really?x=1");
		expect(out).toContain("prompt.condense");
		expect(out).toContain("```ts\nconst just = 'please really';\n```");
		expect(out.startsWith("run")).toBe(true);
	});
	test("no orphan punctuation after removals", () => {
		expect(
			condensePrompt(
				"Hey, I think we should really refactor the retry loop in order to avoid flakiness, if possible.",
			),
		).toBe("we should refactor the retry loop to avoid flakiness.");
	});
	test("plain technical goals pass through unchanged", () => {
		expect(condensePrompt("add csv export")).toBe("add csv export");
	});
});

describe("enhance (belt router, Anthropic wire)", () => {
	test("returns the rewrite on success, posts the Anthropic shape", async () => {
		let seen: Record<string, unknown> = {};
		const fetcher: Fetcher = async (_url, init) => {
			seen = JSON.parse(String(init?.body));
			return Response.json({
				content: [{ type: "text", text: "<think>x</think>Add CSV export." }],
			});
		};
		const r = await enhancePrompt("add csv", { model: "m1", fetcher });
		expect(r.ok).toBe(true);
		expect(r.text).toBe("Add CSV export.");
		expect(seen.model).toBe("m1");
		expect(seen.max_tokens).toBe(400);
		expect(Array.isArray(seen.messages)).toBe(true);
	});
	test("unreachable router degrades to no enhancement", async () => {
		const fetcher: Fetcher = async () => {
			throw new Error("ECONNREFUSED");
		};
		const r = await enhancePrompt("add csv", { model: "m", fetcher });
		expect(r.ok).toBe(false);
		expect(r.text).toBe("add csv");
		expect(r.note).toContain("unreachable");
	});
	test("real closed port degrades too", async () => {
		const r = await enhancePrompt("add csv", {
			model: "m",
			url: "http://127.0.0.1:9/v1/messages",
			timeoutMs: 2000,
		});
		expect(r.ok).toBe(false);
		expect(r.text).toBe("add csv");
	});
	test("HTTP error and empty text degrade", async () => {
		const e500: Fetcher = async () => new Response("boom", { status: 500 });
		expect(
			(await enhancePrompt("g", { model: "m", fetcher: e500 })).note,
		).toContain("HTTP 500");
		const empty: Fetcher = async () => Response.json({ content: [] });
		const r = await enhancePrompt("g", { model: "m", fetcher: empty });
		expect(r.ok).toBe(false);
		expect(r.text).toBe("g");
	});
});

describe("pipeline + disclosure", () => {
	const deps = (enhanced?: string) => ({
		enhance: enhanced
			? async () => ({
					text: enhanced,
					ok: true,
					note: "enhanced",
					model: "m",
					ms: 1,
				})
			: async (t: string) => ({
					text: t,
					ok: false,
					note: "enhance skipped: router unreachable",
					model: "m",
					ms: 1,
				}),
		injections: [
			{ label: "system prompt", text: "SYS" },
			{ label: "repo context", text: "\n\nREPO CONTEXT:\nctx-é" },
		],
		compose: (f: string) => `GOAL:\n${f}\n\nREPO CONTEXT:\nctx-é`,
	});
	test("defaults: condense on, the rest off", () => {
		expect(resolvePromptSettings({})).toEqual(PROMPT_DEFAULTS);
		expect(PROMPT_DEFAULTS["prompt.condense"]).toBe(true);
		expect(
			resolvePromptSettings({ "prompt.log": true, "prompt.debug": "yes" }),
		).toEqual({
			...PROMPT_DEFAULTS,
			"prompt.log": true,
		});
	});
	test("condense off = goal untouched; enhance not called", async () => {
		let called = false;
		const p = await preparePrompt(
			"please add x",
			{ ...PROMPT_DEFAULTS, "prompt.condense": false },
			{
				...deps(),
				enhance: async (t) => {
					called = true;
					return { text: t, ok: true, note: "", model: "m", ms: 0 };
				},
			},
		);
		expect(p.final).toBe("please add x");
		expect(p.condensed).toBeNull();
		expect(called).toBe(false);
	});
	test("enhance success feeds final; fallback keeps condensed", async () => {
		const on = { ...PROMPT_DEFAULTS, "prompt.enhance": true };
		const ok = await preparePrompt("please add x", on, deps("Add X."));
		expect(ok.condensed).toBe("add x");
		expect(ok.final).toBe("Add X.");
		const fb = await preparePrompt("please add x", on, deps());
		expect(fb.enhanced).toBeNull();
		expect(fb.final).toBe("add x");
		expect(fb.enhanceNote).toContain("unreachable");
	});
	test("debug view = final only; log view = every stage + injections with bytes", async () => {
		const on = {
			...PROMPT_DEFAULTS,
			"prompt.enhance": true,
			"prompt.debug": true,
		};
		const p = await preparePrompt("please add x", on, deps("Add X."));
		const dbg = previewView(p);
		expect(dbg.final).toBe("Add X.");
		expect(dbg.stages).toBeUndefined();
		expect(dbg.injected).toBeUndefined();
		const log = previewView({ ...p, settings: { ...on, "prompt.log": true } });
		const stages = log.stages as { label: string; text: string }[];
		expect(stages.map((s) => s.label)).toEqual([
			"original",
			"condensed",
			"enhanced",
		]);
		const inj = log.injected as {
			label: string;
			text: string;
			bytes: number;
		}[];
		expect(inj.map((i) => i.label)).toEqual(["system prompt", "repo context"]);
		expect(inj[1].text).toBe("\n\nREPO CONTEXT:\nctx-é");
		expect(inj[1].bytes).toBe(Buffer.byteLength("\n\nREPO CONTEXT:\nctx-é"));
		expect(log.wireBytes).toBe(Buffer.byteLength(p.wire));
	});
	test("never-empty: a goal that condenses to nothing is kept", async () => {
		const p = await preparePrompt("please", PROMPT_DEFAULTS, deps());
		expect(p.final).toBe("please");
	});
});

describe("secrets never reach the preview", () => {
	test("keys, tokens, assignments and home paths are redacted", () => {
		const raw =
			"use sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz12 token=supersecretvalue in /Users/alice/repo";
		const out = redactSecrets(raw);
		expect(out).not.toContain("sk-abcdefghijklmnop1234");
		expect(out).not.toContain("ghp_");
		expect(out).not.toContain("supersecretvalue");
		expect(out).not.toContain("alice");
		expect(out).toContain("~/repo");
	});
	test("previewView redacts every surfaced field", async () => {
		const p = await preparePrompt(
			"deploy with api_key=hunter2hunter2",
			{ ...PROMPT_DEFAULTS, "prompt.log": true },
			{
				injections: [{ label: "ctx", text: "token: abcdefgh12345" }],
				compose: (f) => f,
			},
		);
		const s = JSON.stringify(previewView(p));
		expect(s).not.toContain("hunter2hunter2");
		expect(s).not.toContain("abcdefgh12345");
		expect(p.final).toContain("hunter2hunter2");
	});
});

describe("preview → dispatch handoff", () => {
	test("held plan is one-shot and bound to project+goal", () => {
		const id = holdPlan({
			project: "/p/.git",
			goal: "g",
			final: "G",
			ctx: "c",
		});
		expect(takePlan(id, "/p/.git", "other")).toBeNull();
		const id2 = holdPlan({
			project: "/p/.git",
			goal: "g",
			final: "G",
			ctx: "c",
		});
		expect(takePlan(id2, "/p/.git", "g")?.final).toBe("G");
		expect(takePlan(id2, "/p/.git", "g")).toBeNull();
	});
	test("expired plan is ignored", () => {
		const id = holdPlan({ project: "p", goal: "g", final: "G", ctx: "c" }, 0);
		expect(takePlan(id, "p", "g", 11 * 60_000)).toBeNull();
	});
});

describe("settings validation (suspenders-board.json)", () => {
	test("prompt.* keys are booleans", () => {
		expect(
			validateBoardSettings({
				"prompt.enhance": true,
				"prompt.condense": false,
			}),
		).toEqual({
			"prompt.enhance": true,
			"prompt.condense": false,
		});
		expect(() => validateBoardSettings({ "prompt.debug": "on" })).toThrow(
			"prompt.debug",
		);
	});
});
