// W1279 — canonical child binding: a `work split --keep` kept child keeps the
// physical worktree on the parent-named branch while its claim (and rebound
// lane-context) names the child. Hermetic fixtures under the OS tmpdir.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	branchForItem,
	laneContextItemForBranch,
} from "../hooks/lib/lanes/item-branch.ts";

const root = mkdtempSync(join(tmpdir(), "item-branch-test-"));
test.afterAll(() => rmSync(root, { recursive: true, force: true }));

// a repo with a linked worktree on the parent-named branch holding a
// lane-context rebound to the kept child (the W1278.1 incident shape)
function keptChildFixture(name: string): { repo: string; tree: string } {
	const dir = join(root, name);
	mkdirSync(dir);
	const sh = (...args: string[]) =>
		Bun.spawnSync(["git", ...args], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
	sh("init", "-q", "-b", "main");
	sh("config", "user.email", "t@t.invalid");
	sh("config", "user.name", "t");
	writeFileSync(join(dir, "a.txt"), "one\n");
	sh("add", ".");
	sh("commit", "-qm", "base");
	const tree = join(dir, ".worktrees", "W1278");
	sh("worktree", "add", "-b", "suspenders/W1278", tree);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(
		join(tree, ".fleet", "lane-context.json"),
		JSON.stringify({ sid: "s1", item: "W1278.1" }),
	);
	return { repo: dir, tree };
}

test.describe("laneContextItemForBranch", () => {
	test("kept-child lane-context outranks the branch-name suffix", () => {
		const f = keptChildFixture("kept");
		expect(laneContextItemForBranch(f.repo, "suspenders/W1278")).toBe(
			"W1278.1",
		);
	});
	test("branch with no tree or context falls through null", () => {
		const f = keptChildFixture("plain");
		expect(laneContextItemForBranch(f.repo, "main")).toBeNull();
	});
});

test.describe("branchForItem", () => {
	test("own ref wins (normal lane)", () => {
		const f = keptChildFixture("ownref");
		Bun.spawnSync(["git", "-C", f.repo, "branch", "suspenders/W1280"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(branchForItem(f.repo, "W1280")).toBe("suspenders/W1280");
	});
	test("kept child resolves to its parent-named branch", () => {
		const f = keptChildFixture("keptbranch");
		expect(branchForItem(f.repo, "W1278.1")).toBe("suspenders/W1278");
	});
	test("unknown item resolves null (caller falls back loud)", () => {
		const f = keptChildFixture("unknown");
		expect(branchForItem(f.repo, "W9999")).toBeNull();
	});
});
