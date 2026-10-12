// test/prefer.test.ts — W517 .prefer discovery: parser grammar, per-key
// nearest-wins walk (crossing repo boundaries by design), the project-key
// TTL cache, and the work-graph stamp end-to-end (`work add` inside a
// .prefer-covered tree tags the item; show/list carry it).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parsePreferFile,
	preferForProject,
	preferTagFor,
	resolvePrefer,
} from "../hooks/lib/prefer.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-prefer-home-"));
const TREE = mkdtempSync(join(tmpdir(), "claude-prefer-tree-"));
const REPO = join(TREE, "covered-repo");
mkdirSync(join(REPO, ".git"), { recursive: true });
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = { ...process.env, HOME };

const work = (...args: string[]): { out: string; code: number } => {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString(), code: p.exitCode };
};

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(TREE, { recursive: true, force: true });
});

describe("parsePreferFile", () => {
	test("full doc: quoted values, comments, blank lines", () => {
		const r = parsePreferFile(
			"/t/.prefer",
			'# header\ntag = "ikea"\n\ncolor = "#0058A3"\nprefer = "ikea llms" # note\n',
		);
		expect(r.errors).toEqual([]);
		expect(r.values).toEqual({
			tag: "ikea",
			color: "#0058A3",
			prefer: "ikea llms",
		});
	});

	test("unquoted values tolerated", () => {
		const r = parsePreferFile("/t/.prefer", "tag = ikea\n");
		expect(r.errors).toEqual([]);
		expect(r.values.tag).toBe("ikea");
	});

	test("unknown key errors loud with the line number", () => {
		const r = parsePreferFile("/t/.prefer", 'tag = "a"\nfoo = "b"\n');
		expect(r.errors).toEqual([
			"/t/.prefer:2: unknown key 'foo = \"b\"' — expected tag, color, prefer, must",
		]);
		expect(r.values.tag).toBe("a"); // valid lines still resolve
	});

	test("color must be RGBHEX #RRGGBB", () => {
		const r = parsePreferFile("/t/.prefer", 'color = "blue"\n');
		expect(r.errors[0]).toContain("color must be RGBHEX");
		expect(r.values.color).toBeUndefined();
	});

	test("tag must be 1-32 chars [a-z0-9-]", () => {
		const r = parsePreferFile("/t/.prefer", 'tag = "two words"\n');
		expect(r.errors[0]).toContain("tag must be 1–32 chars");
	});

	test("routing keys validate as W96 law expressions", () => {
		const r = parsePreferFile("/t/.prefer", 'must = "local cloud"\n');
		expect(r.errors[0]).toContain("must=: duplicate location");
	});

	test("duplicate key: first wins, later one errors", () => {
		const r = parsePreferFile("/t/.prefer", 'tag = "a"\ntag = "b"\n');
		expect(r.values.tag).toBe("a");
		expect(r.errors[0]).toContain("set more than once");
	});
});

describe("resolvePrefer — per-key nearest-wins walk", () => {
	const DEEP = join(TREE, "nested", "leaf");
	mkdirSync(DEEP, { recursive: true });

	test("tree tag inherited; repo color override wins per key", () => {
		writeFileSync(join(TREE, ".prefer"), 'tag = "ikea"\ncolor = "#0058A3"\n');
		writeFileSync(join(TREE, "nested", ".prefer"), 'color = "#BA0D2D"\n');
		const r = resolvePrefer(DEEP);
		expect(r.tag).toBe("ikea");
		expect(r.color).toBe("#BA0D2D"); // nearest definition wins the key
		expect(r.sources.tag).toBe(join(TREE, ".prefer"));
		expect(r.sources.color).toBe(join(TREE, "nested", ".prefer"));
		expect(r.errors).toEqual([]);
	});

	test("walk crosses the repo boundary (tree covers nested repos)", () => {
		// REPO has no own .prefer — the TREE file must still govern
		const r = resolvePrefer(REPO);
		expect(r.tag).toBe("ikea");
		expect(r.sources.tag).toBe(join(TREE, ".prefer"));
	});

	test("nothing found: all null, no errors", () => {
		const empty = mkdtempSync(join(tmpdir(), "claude-prefer-bare-"));
		try {
			const r = resolvePrefer(empty);
			expect(r.tag).toBeNull();
			expect(r.color).toBeNull();
			expect(r.errors).toEqual([]);
			expect(preferTagFor(empty)).toBeNull();
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("preferForProject — project-key cache", () => {
	test("resolves from a git-common-dir key and caches within the TTL", () => {
		const key = join(REPO, ".git"); // the graph's project key shape
		const first = preferForProject(key);
		expect(first.tag).toBe("ikea");
		writeFileSync(join(TREE, ".prefer"), 'tag = "renamed"\n');
		const second = preferForProject(key);
		expect(second.tag).toBe("ikea"); // cached — TTL refreshes shortly
	});
});

describe("work add stamps the tree tag", () => {
	test("item added in a covered repo carries tag in add/list/show", () => {
		writeFileSync(join(TREE, ".prefer"), 'tag = "ikea"\n');
		const a = work("add", "tagged item");
		expect(a.code).toBe(0);
		const id = (a.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).not.toBe("");
		const list = work("list", "all");
		expect(list.out).toContain("#ikea");
		const shown = JSON.parse(work("show", id, "--json").out);
		expect(shown.tags).toBe("ikea");
	});
});
