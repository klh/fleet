import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite0600, modeIs0600 } from "../src/kernel.atomic.module.ts";

describe("kernel atomic", () => {
	test("modeIs0600: exactly 0600 true, others false", () => {
		expect(modeIs0600(0o600)).toBe(true);
		expect(modeIs0600(0o644)).toBe(false);
		// type bits (S_IFREG) ignored — stat().mode round-trips
		expect(modeIs0600(0o100600)).toBe(true);
	});

	test("atomicWrite0600 lands the target 0600 with the exact bytes", () => {
		const dir = join(import.meta.dir, ".tmp-w1254-atomic");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const p = join(dir, "target.json");
		atomicWrite0600(p, `{"a":1}\n`);
		expect(modeIs0600(statSync(p).mode)).toBe(true);
		expect(readFileSync(p, "utf8")).toBe(`{"a":1}\n`);
		const leftovers = readdirSync(dir).filter((f) => f !== "target.json");
		expect(leftovers).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});
});
