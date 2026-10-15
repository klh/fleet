// Regression (W228 grammar): the claude recipe must never write a raw model
// id into ANTHROPIC_MODEL — raw ids 400 client-side ("unrecognized_model").
// The opus alias carries the remap; belt routes by the remapped id.
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
	INSERTION_RECIPES,
	insertionCtx,
	applyInsertion,
} from "../scripts/lib/insertion.ts";
import type { StackConfig } from "../hooks/lib/stack-config.ts";

const stackWith = (
	executors: StackConfig["executors"],
): StackConfig => ({ hubs: {}, executors });

describe("insertion recipes", () => {
	test("claude recipe pins the opus alias + OPUS_MODEL remap, never the raw id", () => {
		const env: Record<string, string> = {};
		applyInsertion(env, "claude", insertionCtx({}, "glm-5.3-flash"));
		expect(env.ANTHROPIC_MODEL).toBe("opus");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
		expect(env.KLH_LANE).toBe("claude");
	});

	test("recipe table never emits a raw id through ANTHROPIC_MODEL", () => {
		const raw = INSERTION_RECIPES.claude?.ANTHROPIC_MODEL;
		expect(typeof raw).toBe("function");
		expect(raw?.(insertionCtx({}, "glm-5.3-flash"))).toBe("opus");
		expect(raw?.(insertionCtx({}, null))).toBeUndefined();
	});
});

describe("insertion stack config (W230)", () => {
	// pin the override knobs — ambient KLH_* in a lane env must not decide
	// these cases (W670 test-env-leak lesson)
	let savedBase: string | undefined;
	let savedModel: string | undefined;
	beforeEach(() => {
		savedBase = process.env.KLH_ENGINE_BASE;
		savedModel = process.env.KLH_DEFAULT_MODEL;
		delete process.env.KLH_ENGINE_BASE;
		delete process.env.KLH_DEFAULT_MODEL;
	});
	afterEach(() => {
		if (savedBase !== undefined) process.env.KLH_ENGINE_BASE = savedBase;
		if (savedModel !== undefined) process.env.KLH_DEFAULT_MODEL = savedModel;
	});

	test("no stack → pre-W230 constants", () => {
		const ctx = insertionCtx({}, null, "claude", null);
		expect(ctx.anthropicBase).toBe("http://127.0.0.1:4000");
		expect(ctx.openaiBase).toBe("http://127.0.0.1:4100/v1");
	});

	test("env override beats the stack executors row", () => {
		const ctx = insertionCtx(
			{ ANTHROPIC_BASE_URL: "http://lane:1" },
			null,
			"claude",
			stackWith({ default: { openai_base: "http://f:2/v1", model: "m-file" } }),
		);
		expect(ctx.anthropicBase).toBe("http://lane:1");
		expect(ctx.openaiBase).toBe("http://f:2/v1");
		expect(ctx.defaultModel).toBe("m-file");
	});

	test("executor row beats the default row; default fills the rest", () => {
		const ctx = insertionCtx(
			{},
			null,
			"claude",
			stackWith({
				default: { openai_base: "http://d:1/v1", model: "m-def" },
				claude: { anthropic_base: "http://c:2", model: "m-claude" },
			}),
		);
		expect(ctx.anthropicBase).toBe("http://c:2");
		expect(ctx.openaiBase).toBe("http://d:1/v1");
		expect(ctx.defaultModel).toBe("m-claude");
	});

	test("applyInsertion rides the row for its own executor", () => {
		const env: Record<string, string> = {};
		applyInsertion(
			env,
			"copilot",
			insertionCtx(
				{},
				null,
				"copilot",
				stackWith({ copilot: { openai_base: "http://row:9/v1", model: "m-row" } }),
			),
		);
		expect(env.COPILOT_PROVIDER_BASE_URL).toBe("http://row:9/v1");
		expect(env.COPILOT_MODEL).toBe("m-row");
	});
});
