// dispatch CLI surface: help is read-only, explicit-item ownership scope,

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../../hooks/lib/govdb.ts";
import { laneSid } from "../../hooks/lib/laneslug.ts";
import { parseCapsuleGet } from "../../scripts/dispatch-next.ts";
import {
	HOME,
	REPO,
	env,
	g,
	tool,
	dispatch,
} from "./fixtures.ts";

describe("CLI help is read-only", () => {
	test("help flags print usage without creating runtime state or claiming work", () => {
		const id =
			(tool("work.ts", "add", "help must not dispatch fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		const before = tool("work.ts", "show", id, "--json").out;
		const stale =
			(tool("work.ts", "add", "help must not resume fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		expect(
			tool(
				"work.ts",
				"take",
				stale,
				"--as",
				"autowhelp",
				"--origin",
				`${hostname()}:claude`,
			).code,
		).toBe(0);
		const row = JSON.parse(tool("work.ts", "show", stale, "--json").out);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.run(
			"UPDATE work_items SET updated_at = 1 WHERE project = ? AND id = ?",
			[row.project, stale],
		);
		db.close();
		const staleBefore = tool("work.ts", "show", stale, "--json").out;
		// hermetic: the split modules run in no guaranteed order — clear any
		// dispatch residue so "help creates no runtime state" is testable.
		rmSync(join(REPO, ".fleet"), { recursive: true, force: true });
		rmSync(join(REPO, ".worktrees"), { recursive: true, force: true });
		for (const help of ["--help", "-h"]) {
			// Even the buggy path cannot spawn real models in this regression.
			const result = dispatch(help, "--target", "0");
			expect(result.code).toBe(0);
			expect(result.out).toContain("Usage: dispatch");
			expect(result.out).not.toContain("lanes live:");
			expect(existsSync(join(REPO, ".fleet"))).toBe(false);
			expect(tool("work.ts", "show", id, "--json").out).toBe(before);
			expect(tool("work.ts", "show", stale, "--json").out).toBe(staleBefore);
			expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
		}
		// This file shares a scratch graph; remove the fixture from later picks.
		expect(tool("work.ts", "fail", id).code).toBe(0);
		expect(tool("work.ts", "fail", stale).code).toBe(0);
	});
});

describe("explicit dispatch ownership scope", () => {
	test("one requested item never recovers unrelated orphan claims", () => {
		const add = (title: string) =>
			tool("work.ts", "add", title).out.match(/W\d+/)?.[0] ?? "";
		const target = add("explicit dispatch target");
		const stale = add("unrelated orphan must stay put");
		expect(
			tool(
				"work.ts",
				"take",
				stale,
				"--as",
				"autowunrelated",
				"--origin",
				`${hostname()}:claude`,
			).code,
		).toBe(0);
		const row = JSON.parse(tool("work.ts", "show", stale, "--json").out);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.run(
			"UPDATE work_items SET updated_at = 1 WHERE project = ? AND id = ?",
			[row.project, stale],
		);
		db.close();
		const before = tool("work.ts", "show", stale, "--json").out;
		const result = dispatch(
			"--dry-run",
			"--item",
			target,
			"--target",
			"1",
			"--no-belt",
		);
		expect(result.code).toBe(0);
		expect(result.out).toContain(`DRY dispatch ${target}`);
		expect(result.out).not.toContain(
			`recovered missing registry identity ${stale}`,
		);
		expect(result.out).not.toContain(`DRY dispatch ${stale}`);
		expect(tool("work.ts", "show", stale, "--json").out).toBe(before);
		const fleet = join(REPO, ".fleet");
		mkdirSync(fleet, { recursive: true });
		writeFileSync(
			join(fleet, "lanes.json"),
			JSON.stringify([
				{
					sid: "autowunrelated",
					item: stale,
					pid: 99999999,
					branch: `suspenders/${stale}`,
					worktree: join(REPO, ".worktrees", stale),
					launchedAt: 1,
					attempt: 0,
				},
			]),
		);
		const registered = dispatch(
			"--dry-run",
			"--item",
			target,
			"--target",
			"1",
			"--no-belt",
		);
		expect(registered.code).toBe(0);
		expect(registered.out).toContain(`DRY dispatch ${target}`);
		expect(registered.out).not.toContain(`DRY dispatch ${stale}`);
		expect(tool("work.ts", "show", stale, "--json").out).toBe(before);
		rmSync(join(fleet, "lanes.json"));

		expect(tool("work.ts", "fail", target).code).toBe(0);
		expect(tool("work.ts", "fail", stale).code).toBe(0);
	});
});

describe("capsule protocol (real coord verb, scratch db)", () => {
	test("write/read round-trip", () => {
		const set = tool(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			"autowrt",
			"--checkpoint=none",
			"--file=src/x.ts:42",
			"--done=parser green",
			"--next=wire the gate",
		);
		expect(set.code).toBe(0);
		const got = tool("coord.ts", "capsule", "get", "--as", "autowrt");
		expect(got.code).toBe(0);
		const cap = parseCapsuleGet(got.out);
		expect(cap).not.toBeNull();
		expect(cap?.checkpoint).toBe("none");
		expect(cap?.next).toBe("wire the gate");
		// empty read is null, not a crash — the fresh-lane path
		expect(parseCapsuleGet("(no capsule)")).toBeNull();
	});
});

describe("dry-run dispatch", () => {
	let id = "";
	test("relative repo input produces absolute lane brief and worktree paths", () => {
		const added = tool("work.ts", "add", "relative-path dispatch regression");
		const item = added.out.match(/W\d+/)?.[0] ?? "";
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../../scripts/dispatch-next.ts"),
				"--repo",
				".",
				"--item",
				item,
				"--dry-run",
			],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain(`repo ${REPO}`);
		expect(r.stdout.toString()).not.toContain("repo .\n");
		const relTake = tool("work.ts", "take", item, "--as", "relative-repo-test");
		expect(relTake.code).toBe(0);
		const relTok = /claim token: ([0-9a-f]{48})/.exec(relTake.out)?.[1];
		expect(
			tool(
				"work.ts",
				"done",
				item,
				"--sha",
				"deadbeef",
				"--as",
				"relative-repo-test",
				...(relTok ? ["--token", relTok] : []),
			).code,
		).toBe(0);
	});
	test("new project lane can be claimed despite legacy session prefix collisions", () => {
		const added = tool("work.ts", "add", "project-qualified claim regression");
		const item = added.out.match(/W\d+/)?.[0] ?? "";
		const legacy = laneSid(item);
		expect(
			tool(
				"coord.ts",
				"bootstrap",
				"--as",
				`${legacy}0`,
				"--name",
				"old lane A",
			).code,
		).toBe(0);
		expect(
			tool(
				"coord.ts",
				"bootstrap",
				"--as",
				`${legacy}1`,
				"--name",
				"old lane B",
			).code,
		).toBe(0);
		expect(tool("work.ts", "take", item, "--as", legacy).err).toContain(
			"ambiguous sid prefix",
		);
		const namespaced = laneSid(item, projectIdentity(REPO));
		const nsTake = tool("work.ts", "take", item, "--as", namespaced);
		expect(nsTake.code).toBe(0);
		const nsTok = /claim token: ([0-9a-f]{48})/.exec(nsTake.out)?.[1];
		expect(
			JSON.parse(tool("work.ts", "show", item, "--json").out).owner_sid,
		).toBe(namespaced);
		const baseline = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
			cwd: REPO,
			encoding: "utf8",
		}).stdout.trim();
		writeFileSync(join(REPO, "fixture.ts"), "export const completed = true;\n");
		g(["add", "fixture.ts"]);
		g(["commit", "-m", "verified fixture completion"]);
		const sha = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
			cwd: REPO,
			encoding: "utf8",
		}).stdout.trim();
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		const context = join(REPO, ".fleet/lane-context.json");
		writeFileSync(
			context,
			JSON.stringify({
				sid: namespaced,
				item,
				baseline,
				claimToken: nsTok,
			}),
		);
		try {
			expect(
				tool(
					"work.ts",
					"done",
					item,
					"--sha",
					sha,
					"--as",
					namespaced,
					"--summary",
					"Verified lane identity survives legacy prefix collisions; committed a real source change with immutable baseline evidence.",
				).code,
			).toBe(0);
		} finally {
			rmSync(context);
		}
	});
	test("prints chosen item + full brief, takes nothing, spawns nothing", () => {
		// priority 5 beats any priority-0 residue from other modules' items,
		// whatever order they ran in.
		const added = tool("work.ts", "add", "sample lane mission", "--priority", "5");
		id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		// hermetic: clear residue so the no-side-effect asserts hold.
		rmSync(join(REPO, ".worktrees"), { recursive: true, force: true });
		rmSync(join(REPO, ".fleet", "lanes.json"), { force: true });
		const out = dispatch("--dry-run", "--target", "1");
		expect(out.out).toContain(`DRY dispatch ${id}`);
		expect(out.out).toContain("CAPSULE PROTOCOL");
		expect(out.out).toContain("LANDING CHAIN");
		// W417.2: the inbox contract rides the brief through the real CLI
		expect(out.out).toContain("INBOX CONTRACT (WS-first)");
		expect(out.out).toContain(
			`coord-subscribe-${laneSid(id, projectIdentity(REPO))}.log`,
		);
		expect(out.out).toContain(
			`inbox --as ${laneSid(id, projectIdentity(REPO))}`,
		);
		expect(out.out).toContain(`lane "${laneSid(id, projectIdentity(REPO))}"`);
		// no side effects: no claim, no worktree, no lane registry
		const show = tool("work.ts", "show", id);
		expect(show.out).toContain("READY");
		expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
		expect(existsSync(join(REPO, ".fleet", "lanes.json"))).toBe(false);
	});

	// W519: a repo .prefer prefer= rides the brief as a SOFT routing note
	// (must= reserved); cleanup keeps the constraint out of sibling cases.
	test("repo .prefer prefer= notes SOFT routing in the dry-run brief", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			'prefer = "ikea llms"\nmust = "cloud"\n',
		);
		try {
			const out = dispatch("--dry-run", "--target", "1");
			expect(out.out).toContain('ROUTING: .prefer prefer="ikea llms"');
			expect(out.out).toContain("SOFT");
			expect(out.out).toContain('ROUTING: .prefer must="cloud"');
			expect(out.out).toContain("RESERVED");
		} finally {
			rmSync(join(REPO, ".prefer"));
		}
	});
});

