import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tailLines } from "../bin/tail-lines.ts";
import { scratchWorld } from "../../test-kit/src/index.ts";

const { home: dir, clean } = scratchWorld({ prefix: "tail-lines-" });
afterAll(() => clean());

const file = (name: string, body: string) => {
	const p = join(dir, name);
	writeFileSync(p, body);
	return p;
};

describe("tailLines", () => {
	test("missing file → []", () => {
		expect(tailLines(join(dir, "nope"), 5)).toEqual([]);
	});
	test("empty file → []", () => {
		expect(tailLines(file("empty", ""), 5)).toEqual([]);
	});
	test("fewer lines than n returns all, trailing newline ignored", () => {
		expect(tailLines(file("small", "a\nb\nc\n"), 12)).toEqual(["a", "b", "c"]);
	});
	test("large file returns exactly the last n, no partial first line", () => {
		const all = Array.from(
			{ length: 5000 },
			(_, i) => `line-${i}-${"x".repeat(40)}`,
		);
		const got = tailLines(file("big", `${all.join("\n")}\n`), 12);
		expect(got).toEqual(all.slice(-12));
	});
	test("lines longer than the first window still resolve", () => {
		const long = "y".repeat(40_000);
		const got = tailLines(file("long", `a\n${long}\n${long}\nz\n`), 2);
		expect(got).toEqual([long, "z"]);
	});
	test("maxBytes bounds the read", () => {
		const all = Array.from({ length: 5000 }, (_, i) => `l${i}`);
		const got = tailLines(file("cap", `${all.join("\n")}\n`), 4000, 4096);
		expect(got.length).toBeLessThan(4000);
		expect(got.at(-1)).toBe("l4999");
	});
});
