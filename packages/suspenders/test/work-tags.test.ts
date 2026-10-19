// test/work-tags.test.ts — W846: mint-time classification tags. CLI surface
// (add --tag validation, show render, split inheritance) against a temp
// project — same harness shape as work-effort.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTags, splitTags, validateTags } from "../hooks/lib/work-tags.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-work-tags-home-"));
const gitInit = (dir: string): void => {
	mkdirSync(dir, { recursive: true });
	const r = Bun.spawnSync(["git", "init", "-q", dir], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (r.exitCode !== 0) throw new Error(`git init failed in ${dir}`);
};
const REPO = mkdtempSync(join(tmpdir(), "work-tags-repo-"));
gitInit(REPO);
const env = { ...process.env, HOME };
const BIN = join(import.meta.dir, "..", "hooks", "bin");

const work = (...args: string[]): { out: string; err: string; code: number | null } => {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: `${p.stdout ?? ""}`,
		err: `${p.stderr ?? ""}`,
		code: p.exitCode,
	};
};
const tagsLine = (out: string): string | undefined =>
	/^ {2}tags: (.+)$/m.exec(out)?.[1];

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("work-tags lib", () => {
	test("splitTags trims and drops empties", () => {
		expect(splitTags("fix, re-land")).toEqual(["fix", "re-land"]);
		expect(splitTags(" fix ")).toEqual(["fix"]);
		expect(splitTags(null)).toEqual([]);
		expect(splitTags(undefined)).toEqual([]);
		expect(splitTags("")).toEqual([]);
	});

	test("validateTags normalizes a csv; throws on a bad token", () => {
		expect(validateTags("fix, re-land")).toBe("fix,re-land");
		expect(validateTags("fix")).toBe("fix");
		expect(() => validateTags("")).toThrow();
		expect(() => validateTags(" , ")).toThrow();
		expect(() => validateTags("bad tag")).toThrow(/invalid tag/);
		expect(() => validateTags("way-too-long-tag-abcdefghijklmnopqrstuvwxyz0123")).toThrow(/invalid tag/);
	});

	test("mergeTags unions distinct, prefer tag first", () => {
		expect(mergeTags(null, "fix")).toBe("fix");
		expect(mergeTags("ikea", "fix")).toBe("ikea,fix");
		expect(mergeTags("ikea", "ikea,fix")).toBe("ikea,fix");
		expect(mergeTags(null, null)).toBeNull();
	});
});

describe("work-tags CLI", () => {
	test("add --tag stamps the tags column; show renders it", () => {
		const a = work("add", "tagged defect child", "--tag", "re-land", "--by", "t");
		expect(a.code).toBe(0);
		const id = (a.out.match(/W\d+/) ?? [""])[0];
		expect(tagsLine(work("show", id).out)).toBe("re-land");
	});

	test("add --tag merges with the .prefer tree tag", () => {
		writeFileSync(join(REPO, ".prefer"), 'tag = "tree-tag"\n');
		const a = work("add", "prefer merged item", "--tag", "fix", "--by", "t");
		expect(a.code).toBe(0);
		const id = (a.out.match(/W\d+/) ?? [""])[0];
		expect(tagsLine(work("show", id).out)).toBe("tree-tag,fix");
	});

	test("invalid tag dies with the grammar message", () => {
		const a = work("add", "bad tag item", "--tag", "bad tag", "--by", "t");
		expect(a.code).not.toBe(0);
		expect(`${a.out}${a.err}`).toMatch(/invalid tag/);
	});

	test("split children inherit the parent classification tags", () => {
		const a = work("add", "fix parent", "--tag", "fix", "--by", "t");
		const parent = (a.out.match(/W\d+/) ?? [""])[0];
		const sp = work("split", parent, "kid a", "kid b", "--reason", "independent-scopes");
		expect(sp.code).toBe(0);
		expect(tagsLine(work("show", `${parent}.1`).out)).toContain("fix");
		expect(tagsLine(work("show", `${parent}.2`).out)).toContain("fix");
	});

	test("show --json carries the tags field", () => {
		const a = work("add", "json tagged", "--tag", "fix", "--by", "t");
		const id = (a.out.match(/W\d+/) ?? [""])[0];
		const row = JSON.parse(work("show", id, "--json").out) as {
			tags?: string | null;
		};
		expect(row.tags).toContain("fix");
	});
});
