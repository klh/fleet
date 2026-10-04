// Regression (W228 grammar): the claude recipe must never write a raw model
// id into ANTHROPIC_MODEL — raw ids 400 client-side ("unrecognized_model").
// The opus alias carries the remap; belt routes by the remapped id.
import { describe, expect, test } from "bun:test";
import {
	INSERTION_RECIPES,
	insertionCtx,
	applyInsertion,
} from "../scripts/lib/insertion.ts";

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
