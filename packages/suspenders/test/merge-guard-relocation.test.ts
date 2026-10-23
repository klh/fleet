import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRelocationDelta } from "../hooks/lib/merge-guard-relocation.ts";

const repos: string[] = [];
const git = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString(),
	};
};
const testLine = (name: string): string =>
	`test(${JSON.stringify(name)}, () => { expect(1).toBe(1); });\n`;
/** Base repo whose test file carries the given test names. */
function fixture(names: string[]): { repo: string; before: string } {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "fleet-reloc-")));
	repos.push(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.invalid");
	const dir = join(repo, "packages/suspenders/test");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(repo, "base.ts"), "export const base = 1;\n");
	writeFileSync(join(dir, "split.test.ts"), names.map(testLine).join(""));
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "base");
	return { repo, before: git(repo, "rev-parse", "HEAD").out };
}
/** Lane-side tree from a mutate callback over the worktree copy. */
function lane(
	repo: string,
	before: string,
	mutate: (dir: string) => void,
): string {
	const dir = join(repo, "packages/suspenders/test");
	git(repo, "checkout", "-b", "suspenders/GUARD", before);
	mutate(dir);
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "lane");
	return git(repo, "rev-parse", "HEAD").out;
}
afterEach(() => {
	for (const repo of repos.splice(0))
		rmSync(repo, { recursive: true, force: true });
});

test("balanced split — tests moved to a sibling keep the delta net-zero", () => {
	const names = ["a", "b", "c", "d", "e"];
	const { repo, before } = fixture(names);
	const head = lane(repo, before, (dir) => {
		const src = join(dir, "split.test.ts");
		const kept = names.slice(0, 2).map(testLine).join("");
		writeFileSync(src, kept);
		writeFileSync(
			join(dir, "sibling.test.ts"),
			names.slice(2).map(testLine).join(""),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(true);
});

test("erosion — deleted tests without a sibling fail closed", () => {
	const names = ["a", "b", "c", "d", "e"];
	const { repo, before } = fixture(names);
	const head = lane(repo, before, (dir) => {
		writeFileSync(
			join(dir, "split.test.ts"),
			names.slice(0, 2).map(testLine).join(""),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("not relocated");
});

test("renamed test fails closed (old name unrelocated, new name unrelated)", () => {
	const names = ["a", "b", "c"];
	const { repo, before } = fixture(names);
	const head = lane(repo, before, (dir) => {
		writeFileSync(
			join(dir, "split.test.ts"),
			names.slice(0, 1).map(testLine).join(""),
		);
		writeFileSync(
			join(dir, "sibling.test.ts"),
			["b", "c2"].map(testLine).join(""),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("not relocated");
	expect(r.why).toContain("unrelated addition");
});

test("unrelated new test alongside a real move fails closed", () => {
	const names = ["a", "b", "c"];
	const { repo, before } = fixture(names);
	const head = lane(repo, before, (dir) => {
		writeFileSync(
			join(dir, "split.test.ts"),
			names.slice(0, 1).map(testLine).join(""),
		);
		writeFileSync(
			join(dir, "sibling.test.ts"),
			["b", "c", "extra"].map(testLine).join(""),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("unrelated addition");
});
