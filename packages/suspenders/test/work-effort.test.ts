// test/work-effort.test.ts — W248: per-item effort budget. Lib contract
// (vocabulary + budget lines + show-parse) and the CLI surface (add --effort
// validation, show render, split inheritance) against a temp project.
import { afterAll, describe, expect, test } from "bun:test";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";
import {
	effortBudgetLine,
	effortFromShow,
	EFFORTS,
} from "../hooks/lib/work/work-effort.ts";

const f = cliFixture("work-effort");

const work = (...args: string[]) => f.run("work.ts", args);
const effortLine = (out: string): string | undefined =>
	/^ {2}effort: (.+)$/m.exec(out)?.[1];

afterAll(f.cleanup);

describe("effort budget lib", () => {
	test("EFFORTS vocabulary is simple | complex", () => {
		expect([...EFFORTS]).toEqual(["simple", "complex"]);
	});

	test("budget line per effort class; unset → null (legacy briefs unchanged)", () => {
		expect(
			effortBudgetLine("simple")?.startsWith("EFFORT BUDGET: simple"),
		).toBe(true);
		expect(
			effortBudgetLine("complex")?.startsWith("EFFORT BUDGET: complex"),
		).toBe(true);
		expect(effortBudgetLine(null)).toBeNull();
		expect(effortBudgetLine(undefined)).toBeNull();
		expect(effortBudgetLine("huge")).toBeNull();
	});

	test("effortFromShow parses the two-space field render; unknown → null", () => {
		const shown = "◐ W1 CLAIMED  item\n  scope: suspenders\n  effort: simple";
		// the render contract is ONE field line — first match wins
		expect(effortFromShow(shown)).toBe("simple");
		expect(effortFromShow(`${shown}\n  effort: complex`)).toBe("simple");
		expect(effortFromShow("◐ W1 READY  item")).toBeNull();
		expect(effortFromShow("◐ W1 READY  item\n  effort: huge")).toBeNull();
		expect(effortFromShow("\x1b[2m  effort: complex\x1b[0m")).toBe("complex");
	});
});

describe("effort CLI", () => {
	test("add --effort stamps the field; show renders it; invalid dies", () => {
		const a = work("add", "effort smoke", "--effort", "simple", "--by", "t");
		expect(a.code).toBe(0);
		const id = (a.out.match(/W\d+/) ?? [""])[0];
		expect(effortLine(work("show", id).out)).toBe("simple");
	});

	test("unset effort: show has no effort line (legacy rows render unchanged)", () => {
		const a = work("add", "legacy item", "--by", "t");
		const id = (a.out.match(/W\d+/) ?? [""])[0];
		expect(effortLine(work("show", id).out)).toBeUndefined();
	});

	test("split children inherit the parent effort", () => {
		const a = work("add", "complex parent", "--effort", "complex", "--by", "t");
		const parent = (a.out.match(/W\d+/) ?? [""])[0];
		const sp = work(
			"split",
			parent,
			"kid a",
			"kid b",
			"--reason",
			"independent-scopes",
		);
		expect(sp.code).toBe(0);
		expect(effortLine(work("show", `${parent}.1`).out)).toBe("complex");
		expect(effortLine(work("show", `${parent}.2`).out)).toBe("complex");
	});

	test("show --json carries the effort field", () => {
		const a = work("add", "json item", "--effort", "complex", "--by", "t");
		const id = (a.out.match(/W\d+/) ?? [""])[0];
		const row = JSON.parse(work("show", id, "--json").out) as {
			effort?: string | null;
		};
		expect(row.effort).toBe("complex");
	});
});
