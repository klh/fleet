// prompt-transform.test.ts — W270 orchestrate prompt transforms: condense
// determinism, enhance fallback, injection disclosure, secret redaction,
// preview→dispatch handoff.
import { afterEach, describe, expect, test } from "bun:test";
import {
	condensePrompt,
	ENHANCE_HINT,
	ENHANCE_MODEL,
	enhancePrompt,
	type Fetcher,
	holdPlan,
	PROMPT_DEFAULTS,
	preparePrompt,
	previewView,
	redactSecrets,
	resolveEnhanceTarget,
	resolvePromptSettings,
	takePlan,
} from "../hooks/board/prompt-transform.ts";
import { buckleChat } from "../hooks/lib/inference-buckle.ts";
import { validateBoardSettings } from "../hooks/lib/board-config.ts";

// W1119 stub credential pair — the knowledge-buckle contract both-or-neither
const GATE_ENV = {
	SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101",
	SUSPENDERS_BUCKLE_TOKEN: "bksk_pt_test",
};

const FLUFFY =
	"Hi there! Could you please just basically add a CSV export to the `tasks` table in hooks/board/data.ts? I would like you to make sure that it streams. I would like you to make sure that it streams. Thanks so much!";

describe("prompt condenser", () => {
	test("strips politeness, keeps hedges and technical terms", () => {
		const out = condensePrompt(FLUFFY);
		expect(out).toContain("add a CSV export");
		expect(out).toContain("`tasks`");
		expect(out).toContain("hooks/board/data.ts");
		expect(out).toContain("I would like you to make sure that it streams");
		for (const w of ["Hi", "please", "Thanks", "Could you"])
			expect(out).not.toContain(w);
		// W287: hedges are meaning — they survive
		for (const h of ["just", "basically"]) expect(out).toContain(h);
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
	test("hedges survive untouched", () => {
		expect(
			condensePrompt(
				"Hey, I think we should really refactor the retry loop in order to avoid flakiness, if possible.",
			),
		).toBe(
			"I think we should really refactor the retry loop in order to avoid flakiness, if possible.",
		);
	});
	test("politeness-only: wrapper families strip, content stays", () => {
		expect(
			condensePrompt(
				"Hi there! Could you kindly go ahead and please ship it. Thanks in advance!",
			),
		).toBe("ship it.");
	});
	test("W278 review #4 cases keep their meaning", () => {
		const hedge = "Maybe add a retry, but just for the 429 case.";
		expect(condensePrompt(hedge)).toBe(hedge);
		expect(
			condensePrompt(
				"Could you please make sure that the kind of error is logged?",
			),
		).toBe("make sure that the kind of error is logged?");
	});
	test("plain technical goals pass through unchanged", () => {
		expect(condensePrompt("add csv export")).toBe("add csv export");
	});
});

describe("enhance through the gate (W1119)", () => {
	test("rewrites via the gated leg: auth + hint ride, think block stripped", async () => {
		let seen: { url: string; auth: string | null; hint: string | null } = {
			url: "",
			auth: null,
			hint: null,
		};
		let calls = 0;
		const fetcher: Fetcher = (async (input: unknown, init?: RequestInit) => {
			calls++;
			const h = new Headers(init?.headers);
			seen = {
				url: String(input),
				auth: h.get("authorization"),
				hint: h.get("x-belt-hint"),
			};
			return Response.json({
				model: "served",
				content: [{ type: "text", text: "<think>x</think>Add CSV export." }],
			});
		}) as unknown as typeof fetch;
		const r = await enhancePrompt("add csv", { env: GATE_ENV, fetcher });
		expect(calls).toBe(1);
		expect(r.ok).toBe(true);
		expect(r.text).toBe("Add CSV export.");
		expect(r.model).toBe("local-extract");
		expect(seen.url).toBe("http://127.0.0.1:4101/v1/messages");
		expect(seen.auth).toBe("Bearer bksk_pt_test");
		expect(seen.hint).toBe(ENHANCE_HINT);
	});
	test("down gate degrades honestly — no reroute, second leg never fires", async () => {
		let calls = 0;
		const fetcher: Fetcher = (async () => {
			calls++;
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const r = await enhancePrompt("add csv", { env: GATE_ENV, fetcher });
		expect(calls).toBe(1);
		expect(r.ok).toBe(false);
		expect(r.text).toBe("add csv");
		expect(r.note).toContain("buckle");
	});
	test("missing scoped key fails closed before any fetch", async () => {
		const fetcher: Fetcher = (async () => {
			throw new Error("must never fetch");
		}) as unknown as typeof fetch;
		const r = await enhancePrompt("add csv", {
			env: { SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101" },
			fetcher,
		});
		expect(r.ok).toBe(false);
		expect(r.text).toBe("add csv");
		expect(r.note).toContain("together");
	});
	test("gate refusal (HTTP 401) degrades without inventing text", async () => {
		const r = await enhancePrompt("add csv", {
			env: GATE_ENV,
			fetcher: (async () =>
				new Response('{"error":"missing credential"}', {
					status: 401,
				})) as unknown as typeof fetch,
		});
		expect(r.ok).toBe(false);
		expect(r.text).toBe("add csv");
		expect(r.note).toContain("HTTP 401");
	});
	test("empty rewrite text degrades to the untouched goal", async () => {
		const r = await enhancePrompt("add csv", {
			env: GATE_ENV,
			fetcher: (async () =>
				Response.json({
					content: [{ type: "text", text: "  " }],
				})) as unknown as typeof fetch,
		});
		expect(r.ok).toBe(false);
		expect(r.text).toBe("add csv");
	});
	test("HTTP error and empty text degrade", async () => {
		const boom = await enhancePrompt("add csv", {
			env: GATE_ENV,
			fetcher: (async () =>
				new Response('{"error":"boom"}', { status: 500 })) as unknown as typeof fetch,
		});
		expect(boom.ok).toBe(false);
		expect(boom.note).toContain("HTTP 500");
		const blank = await enhancePrompt("add csv", {
			env: GATE_ENV,
			fetcher: (async () =>
				Response.json({
					content: [{ type: "text", text: "" }],
				})) as unknown as typeof fetch,
		});
		expect(blank.ok).toBe(false);
		expect(blank.text).toBe("add csv");
	});
	test("W422.17.3: gate refusal degrades honestly, never invents text", async () => {
		const r = await enhancePrompt("add csv", {
			env: GATE_ENV,
			fetcher: (async () =>
				new Response('{"error":"denied"}', { status: 403 })) as unknown as typeof fetch,
		});
		expect(r.ok).toBe(false);
		expect(r.text).toBe("add csv");
		expect(r.note).toContain("HTTP 403");
	});
	test("W422.17.3: key rides both wire forms; keyless sends no credential", async () => {
		let auth: string | null = null;
		const keyed = await enhancePrompt("add csv", {
			env: GATE_ENV,
			fetcher: (async (_input: unknown, init?: RequestInit) => {
				auth = new Headers(init?.headers).get("authorization");
				return Response.json({
					content: [{ type: "text", text: "Add CSV export." }],
				});
			}) as unknown as typeof fetch,
		});
		expect(keyed.ok).toBe(true);
		expect(auth).toBe("Bearer bksk_pt_test");
		const keyless = await enhancePrompt("add csv", {
			env: { SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101" },
			fetcher: (async () => {
				throw new Error("must never fetch");
			}) as unknown as typeof fetch,
		});
		expect(keyless.ok).toBe(false);
		expect(keyless.text).toBe("add csv");
	});
	test("posts system+user messages, parses choices[].message", async () => {
		let body = "";
		const r = await enhancePrompt("add csv", {
			env: GATE_ENV,
			fetcher: (async (_input: unknown, init?: RequestInit) => {
				body = String(init?.body ?? "");
				return Response.json({
					content: [{ type: "text", text: "Add CSV export." }],
				});
			}) as unknown as typeof fetch,
		});
		expect(r.ok).toBe(true);
		expect(r.text).toBe("Add CSV export.");
		const wire = JSON.parse(body) as {
			system?: string;
			messages?: { role: string; content: unknown }[];
		};
		expect(typeof wire.system).toBe("string");
		expect(wire.messages?.some((m) => m.role === "user")).toBe(true);
	});
	test("same degrade notes as the anthropic wire", async () => {
		const noteFor = async (status: number) =>
			(
				await enhancePrompt("add csv", {
					env: GATE_ENV,
					fetcher: (async () =>
						new Response('{"error":"x"}', {
							status,
						})) as unknown as typeof fetch,
				})
			).note ?? "";
		const n401 = await noteFor(401);
		const n500 = await noteFor(503);
		expect(n401.split("HTTP")[0]).toBe(n500.split("HTTP")[0]);
		expect(n401).toContain("HTTP 401");
		expect(n500).toContain("HTTP 503");
	});
	test("model pin → gateway with the pinned id", async () => {
		let pinned = "";
		const r = await enhancePrompt("add csv", {
			model: "glm-5.3-flash",
			env: GATE_ENV,
			fetcher: (async (_input: unknown, init?: RequestInit) => {
				pinned = String(
					(JSON.parse(String(init?.body ?? "{}")) as { model?: string })
						.model ?? "",
				);
				return Response.json({
					content: [{ type: "text", text: "Add CSV export." }],
				});
			}) as unknown as typeof fetch,
		});
		expect(r.ok).toBe(true);
		expect(r.model).toBe("glm-5.3-flash");
		expect(pinned).toBe("glm-5.3-flash");
	});
	test("url pin → gateway on the pin, alias id", async () => {
		let url = "";
		const r = await enhancePrompt("add csv", {
			env: { ...GATE_ENV, SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4321" },
			fetcher: (async (input: unknown) => {
				url = String(input);
				return Response.json({
					content: [{ type: "text", text: "Add CSV export." }],
				});
			}) as unknown as typeof fetch,
		});
		expect(url).toBe("http://127.0.0.1:4321/v1/messages");
		expect(r.ok).toBe(true);
		expect(r.model).toBe(ENHANCE_MODEL);
	});
});
describe("enhancePrompt (openai wire, W288)", () => {
	test("openai wire folds system into messages, parses choices[].message", async () => {
		let body = "";
		const r = await buckleChat(
			{
				model: "local-extract",
				system: "sys prompt",
				user: "add csv",
				wire: "openai",
				fetcher: (async (_input: unknown, init?: RequestInit) => {
					body = String(init?.body ?? "");
					return Response.json({
						choices: [{ message: { content: "Add CSV export." } }],
					});
				}) as unknown as typeof fetch,
			},
			{ ...GATE_ENV },
		);
		expect(r.text).toBe("Add CSV export.");
		const wire = JSON.parse(body) as {
			messages?: { role: string; content: unknown }[];
		};
		expect(wire.messages?.[0]?.role).toBe("system");
		expect(wire.messages?.at(-1)).toMatchObject({ role: "user" });
	});
});

describe("enhance target resolution (W1119)", () => {
	afterEach(() => {
		delete process.env.SUSPENDERS_PROMPT_MODEL;
	});
	test("model pin rides as data; no endpoint is resolved", async () => {
		process.env.SUSPENDERS_PROMPT_MODEL = "glm-5.3-flash";
		expect(await resolveEnhanceTarget()).toEqual({
			mode: "buckle",
			model: "glm-5.3-flash",
		});
	});
	test("default resolves to the extract preference through buckle", async () => {
		delete process.env.SUSPENDERS_PROMPT_MODEL;
		expect(await resolveEnhanceTarget()).toEqual({
			mode: "buckle",
			model: ENHANCE_MODEL,
		});
	});
	test("enhancePrompt honors a call-time model pin", async () => {
		const r = await enhancePrompt("add csv", {
			env: {
				...GATE_ENV,
				SUSPENDERS_PROMPT_MODEL: "glm-5.3-flash",
			},
			fetcher: (async () =>
				Response.json({
					content: [{ type: "text", text: "Add CSV export." }],
				})) as unknown as typeof fetch,
		});
		expect(r.ok).toBe(true);
		expect(r.model).toBe("glm-5.3-flash");
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
	test("defaults: condense ON (owner reversal 2026-10-03), the rest off", () => {
		expect(resolvePromptSettings({})).toEqual(PROMPT_DEFAULTS);
		expect(PROMPT_DEFAULTS["prompt.condense"]).toBe(true);
		expect(
			resolvePromptSettings({ "prompt.log": true, "prompt.debug": "yes" }),
		).toEqual({
			...PROMPT_DEFAULTS,
			"prompt.log": true,
		});
	});
	test("default settings condense politely (condense default on)", async () => {
		const p = await preparePrompt("please add x", PROMPT_DEFAULTS, deps());
		expect(p.final).toBe("add x"); // politeness strip runs, goal intact
		expect(previewView(p).ran).toEqual({ condense: true, enhance: false });
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
		const on = {
			...PROMPT_DEFAULTS,
			"prompt.condense": true,
			"prompt.enhance": true,
		};
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
			"prompt.condense": true,
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
		const p = await preparePrompt(
			"please",
			{ ...PROMPT_DEFAULTS, "prompt.condense": true },
			deps(),
		);
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
