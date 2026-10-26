import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailLines } from "../bin/tail-lines.ts";

const dir = mkdtempSync(join(tmpdir(), "tail-lines-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, body: string) => {
	const p = join(dir, name);
	writeFileSync(p, body);
	return p;
};

test.describe("tailLines", () => {
	test("missing file → [] @unit", () => {
		expect(tailLines(join(dir, "nope"), 5)).toEqual([]);
	});
	test("empty file → [] @unit", () => {
		expect(tailLines(file("empty", ""), 5)).toEqual([]);
	});
	test("fewer lines than n returns all, trailing newline ignored @unit", () => {
		expect(tailLines(file("small", "a\nb\nc\n"), 12)).toEqual(["a", "b", "c"]);
	});
	test("large file returns exactly the last n, no partial first line @unit", () => {
		const all = Array.from(
			{ length: 5000 },
			(_, i) => `line-${i}-${"x".repeat(40)}`,
		);
		const got = tailLines(file("big", `${all.join("\n")}\n`), 12);
		expect(got).toEqual(all.slice(-12));
	});
	test("lines longer than the first window still resolve @unit", () => {
		const long = "y".repeat(40_000);
		const got = tailLines(file("long", `a\n${long}\n${long}\nz\n`), 2);
		expect(got).toEqual([long, "z"]);
	});
	test("maxBytes bounds the read @unit", () => {
		const all = Array.from({ length: 5000 }, (_, i) => `l${i}`);
		const got = tailLines(file("cap", `${all.join("\n")}\n`), 4000, 4096);
		expect(got.length).toBeLessThan(4000);
		expect(got.at(-1)).toBe("l4999");
	});
});
