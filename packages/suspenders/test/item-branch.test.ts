// W1279 — canonical child binding: a `work split --keep` kept child keeps the
// physical worktree on the parent-named branch while its claim (and rebound
// lane-context) names the child. Hermetic fixtures under the OS tmpdir.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	branchForItem,
	laneContextItemForBranch,
} from "../hooks/lib/lanes/item-branch.ts";

const root = mkdtempSync(join(tmpdir(), "item-branch-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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

describe("laneContextItemForBranch", () => {
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

describe("branchForItem", () => {
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

// W3010: the graph walk binds a kept child whose carrier tree lost its
// lane-context (reaped/retired tree, pre-W628 split — the 77aa incident):
// SHATTERED ancestor, ref exists, result sha on it — never a blind name.
describe("branchForItem graph walk (W3010)", () => {
	const rowMap =
		(rows: Record<string, { state: string; parent_id: string | null }>) =>
		(id: string) =>
			rows[id] ?? null;
	const headOf = (repo: string): string =>
		Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], {
			stdout: "pipe",
			stderr: "pipe",
		})
			.stdout.toString()
			.trim();

	test("binds the SHATTERED ancestor whose ref contains the result sha", () => {
		const f = keptChildFixture("carrier");
		const sha = headOf(f.repo);
		// the incident shape: the carrier tree's lane-context is gone
		rmSync(join(f.tree, ".fleet", "lane-context.json"));
		expect(
			branchForItem(f.repo, "W1278.1", {
				parentId: "W1278",
				resultSha: sha,
				rowAt: rowMap({ W1278: { state: "SHATTERED", parent_id: null } }),
			}),
		).toBe("suspenders/W1278");
	});

	test("a ref-bearing ancestor missing the result sha binds nothing", () => {
		const f = keptChildFixture("wrongcarrier");
		Bun.spawnSync(["git", "-C", f.repo, "branch", "suspenders/W1278"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		writeFileSync(join(f.repo, "late.txt"), "x");
		Bun.spawnSync(["git", "-C", f.repo, "add", "."], {
			stdout: "pipe",
			stderr: "pipe",
		});
		Bun.spawnSync(["git", "-C", f.repo, "commit", "-qm", "late"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		// suspenders/W1278 sits at base; `late` is only on main — never an
		// ancestor of the carrier ref, so the wrong carrier must not bind
		const late = headOf(f.repo);
		expect(
			branchForItem(f.repo, "W1278.2", {
				parentId: "W1278",
				resultSha: late,
				rowAt: rowMap({ W1278: { state: "SHATTERED", parent_id: null } }),
			}),
		).toBeNull();
	});

	test("walks through a ref-less SHATTERED ancestor to the standing carrier", () => {
		const f = keptChildFixture("walkup");
		// strip the direct carrier: remove the worktree, delete its branch
		Bun.spawnSync(
			["git", "-C", f.repo, "worktree", "remove", "--force", f.tree],
			{ stdout: "pipe", stderr: "pipe" },
		);
		Bun.spawnSync(["git", "-C", f.repo, "branch", "-D", "suspenders/W1278"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		Bun.spawnSync(["git", "-C", f.repo, "branch", "suspenders/W90"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(
			branchForItem(f.repo, "W1278.2", {
				parentId: "W1278",
				resultSha: headOf(f.repo),
				rowAt: rowMap({
					W1278: { state: "SHATTERED", parent_id: "W90" },
					W90: { state: "SHATTERED", parent_id: null },
				}),
			}),
		).toBe("suspenders/W90");
	});

	test("a non-SHATTERED ancestor stops the walk", () => {
		const f = keptChildFixture("readyroot");
		Bun.spawnSync(
			["git", "-C", f.repo, "worktree", "remove", "--force", f.tree],
			{ stdout: "pipe", stderr: "pipe" },
		);
		Bun.spawnSync(["git", "-C", f.repo, "branch", "-D", "suspenders/W1278"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		Bun.spawnSync(["git", "-C", f.repo, "branch", "suspenders/W90"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(
			branchForItem(f.repo, "W1278.2", {
				parentId: "W1278",
				resultSha: headOf(f.repo),
				rowAt: rowMap({
					W1278: { state: "SHATTERED", parent_id: "W90" },
					W90: { state: "READY", parent_id: null },
				}),
			}),
		).toBeNull();
	});

	test("no pinned result sha binds nothing (shape alone never binds)", () => {
		const f = keptChildFixture("nopin");
		rmSync(join(f.tree, ".fleet", "lane-context.json"));
		expect(
			branchForItem(f.repo, "W1278.2", {
				parentId: "W1278",
				rowAt: rowMap({ W1278: { state: "SHATTERED", parent_id: null } }),
			}),
		).toBeNull();
	});
});
