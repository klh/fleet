import { beforeEach, describe, expect, test } from "bun:test";
import { env } from "../src/kernel.env.module.ts";

describe("kernel env (trim-and-empty semantics)", () => {
	const KEY = "KERNEL_W1254_ENV_PROBE";

	beforeEach(() => {
		delete process.env[KEY];
	});

	test("str: unset falls back", () => {
		expect(env.str(KEY, "fb")).toBe("fb");
	});

	test("str: empty and whitespace fall back", () => {
		process.env[KEY] = "";
		expect(env.str(KEY, "fb")).toBe("fb");
		process.env[KEY] = "   ";
		expect(env.str(KEY, "fb")).toBe("fb");
	});

	test("str: value returns trimmed", () => {
		process.env[KEY] = "  v  ";
		expect(env.str(KEY, "fb")).toBe("v");
	});

	test("num: unset, empty, garbage fall back", () => {
		expect(env.num(KEY, 5)).toBe(5);
		process.env[KEY] = "";
		expect(env.num(KEY, 5)).toBe(5);
		process.env[KEY] = "abc";
		expect(env.num(KEY, 5)).toBe(5);
	});

	test("num: 0 and negatives are values, not fallbacks", () => {
		process.env[KEY] = "0";
		expect(env.num(KEY, 5)).toBe(0);
		process.env[KEY] = "-1";
		expect(env.num(KEY, 5)).toBe(-1);
	});
});
