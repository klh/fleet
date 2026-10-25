// test/dispatch-next.test.ts — W145: suspenders dispatches its own fan-outs
// through the fleet machinery. Covered: the capsule write/read round-trip
// through the REAL coord verb (scratch-HOME governor db), dry-run dispatch
// (prints item + brief, spawns nothing, takes nothing), and resume-rebrief
// composition (dead lane's last capsule returns as RESUME CONTEXT).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
import { laneSid } from "../hooks/lib/lanes/laneslug.ts";
import {
	capabilityGate,
	composeBrief,
	isOwnerGated,
	parseCapsuleGet,
	parseReady,
	residueOf,
} from "../scripts/dispatch-next.ts";
import {
	env,
	g,
	HOME,
	REPO,
	dispatch,
	tool,
	workSnapshot,
} from "./helpers/dispatch-next-kit.ts";

describe("CLI help is read-only", () => {
	test("help flags print usage without creating runtime state or claiming work", () => {
		const id =
			(tool("work.ts", "add", "help must not dispatch fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		const before = workSnapshot(id);
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
		const staleBefore = workSnapshot(stale);
		// W870: the take above provisions a tree — help must add none beyond it
		const wtExisted = existsSync(join(REPO, ".worktrees"));
		for (const help of ["--help", "-h"]) {
			// Even the buggy path cannot spawn real models in this regression.
			const result = dispatch(help, "--target", "0");
			expect(result.code).toBe(0);
			expect(result.out).toContain("Usage: dispatch");
			expect(result.out).not.toContain("lanes live:");
			expect(existsSync(join(REPO, ".fleet"))).toBe(false);
			expect(workSnapshot(id)).toEqual(before);
			expect(workSnapshot(stale)).toEqual(staleBefore);
			expect(existsSync(join(REPO, ".worktrees"))).toBe(wtExisted);
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
		const before = workSnapshot(stale);
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
		expect(workSnapshot(stale)).toEqual(before);
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
		expect(workSnapshot(stale)).toEqual(before);
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
	test("explicit plaid route survives dry-run selection without a fallback", () => {
		const item =
			tool("work.ts", "add", "pinned GLM dispatch fixture").out.match(
				/W\d+/,
			)?.[0] ?? "";
		const fleet = join(REPO, ".fleet");
		mkdirSync(fleet, { recursive: true });
		writeFileSync(join(fleet, "posture"), "plaid\n");
		try {
			const preview = dispatch(
				"--dry-run",
				"--item",
				item,
				"--route",
				"glm-5.3-flash",
				"--no-belt",
			);
			expect(preview.code).toBe(0);
			expect(preview.out).toContain("DRY route pin glm-5.3-flash");
			expect(preview.out).toContain(
				"DRY selected route glm-5.3-flash (GLM 5.3 Flash)",
			);
			expect(preview.out).not.toContain("+fallback-model");
		} finally {
			rmSync(join(fleet, "posture"));
			tool("work.ts", "fail", item);
		}
	});
	test("relative repo input produces absolute lane brief and worktree paths", () => {
		const added = tool("work.ts", "add", "relative-path dispatch regression");
		const item = added.out.match(/W\d+/)?.[0] ?? "";
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../scripts/dispatch-next.ts"),
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
		// W254: the scratch repo is under the W113 small-repo gate — no
		// derived FILE MAP ever rides a brief composed for it
		expect(r.stdout.toString()).not.toContain("FILE MAP");
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
		const added = tool("work.ts", "add", "sample lane mission");
		id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		// W870: sibling tests' takes leave trees standing — this run must add
		// none of its own (dry-run takes nothing)
		const wtExisted = existsSync(join(REPO, ".worktrees"));
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
		// no side effects: no claim, no NEW worktree, no lane registry
		const show = tool("work.ts", "show", id);
		expect(show.out).toContain("READY");
		expect(existsSync(join(REPO, ".worktrees"))).toBe(wtExisted);
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

describe("resume-rebrief composition", () => {
	test("dead lane's capsule returns as RESUME CONTEXT", () => {
		const showOut = "◐ W140 RUNNING  sample item\n  owner_sid: autow140";
		const base = {
			item: "W140",
			showOut,
			sid: "autow140",
			branch: "suspenders/W140",
			worktree: "/tmp/nowhere/.worktrees/W140",
		};
		const fresh = composeBrief({ ...base, capsule: null });
		expect(fresh).not.toContain("RESUME CONTEXT —");
		expect(fresh).toContain("CAPSULE PROTOCOL");
		expect(fresh).toContain("FORMAT: read the nearest .qlty/qlty.toml");
		expect(fresh).toContain("Never chase formatter wrapping by hand.");
		expect(fresh).toContain(`done W140 --sha <branch-head> --as autow140`);
		expect(fresh).toContain("finding.w140");
		const resumed = composeBrief({
			...base,
			capsule: { checkpoint: "abc123", done: "half", next: "other half" },
		});
		expect(resumed).toContain("RESUME CONTEXT —");
		expect(resumed).toContain("abc123");
	});
	// W617: the item-scoped capsule rides for ANY claimer — a fresh lane on
	// a reclaimed item resumes informed, not just the reused sid.
	test("item capsule injects as RESUME CONTEXT for any claimer", () => {
		const showOut = "◐ W617 CLAIMED  sample item\n  owner_sid: autow617";
		const base = {
			item: "W617",
			showOut,
			sid: "freshlane",
			branch: "suspenders/W617",
			worktree: "/tmp/nowhere/.worktrees/W617",
			capsule: null,
		};
		const fresh = composeBrief({
			...base,
			itemCapsule: { checkpoint: "deadbeef", done: "half", next: "rest" },
		});
		expect(fresh).toContain(
			"RESUME CONTEXT — item capsule from a previous lane on this item",
		);
		expect(fresh).toContain("deadbeef");
		// no item capsule → no block
		expect(composeBrief(base)).not.toContain("item capsule");
		// same-sid resume where lane capsule == item capsule → printed once
		const cap = { checkpoint: "abc123", done: "half", next: "rest" };
		const deduped = composeBrief({ ...base, capsule: cap, itemCapsule: cap });
		expect(deduped.match(/RESUME CONTEXT —/g)).toHaveLength(1);
	});
	// W417.2: the inbox contract is executor-agnostic — one line on every
	// brief, regardless of the agent the lane rides (claude, codex, copilot,
	// cline, grok). Asserted across executor classes.
	test("inbox contract line rides every brief, all executors", () => {
		const opts = {
			item: "W140",
			showOut: "◐ W140 RUNNING  sample item\n  owner_sid: autow140",
			sid: "autow140",
			branch: "suspenders/W140",
			worktree: "/tmp/nowhere/.worktrees/W140",
			capsule: null,
		};
		for (const agent of ["claude", "codex", "copilot", "cline", "grok"]) {
			const brief = composeBrief({ ...opts, agent });
			expect(brief).toContain("INBOX CONTRACT (WS-first)");
			expect(brief).toContain(`coord-subscribe-${opts.sid}.log`);
			expect(brief).toContain(`inbox --as ${opts.sid}`);
			expect(brief).toContain(
				"A supervisor correction sent to this sid updates the current mission",
			);
		}
	});

	// W248: the per-item effort budget rides the brief — simple = work solo,
	// 3-10 tool calls; complex = fan out; unset = no budget line at all.
	test("effort budget line composes from the item's effort field", () => {
		const opts = {
			item: "W248",
			showOut: "◐ W248 READY  sample item\n  effort: complex",
			sid: "autow248",
			branch: "suspenders/W248",
			worktree: "/tmp/nowhere/.worktrees/W248",
			capsule: null,
		};
		// call sites pass effort: effortFromShow(show.out) — same contract here
		expect(composeBrief({ ...opts, effort: "complex" })).toContain(
			"EFFORT BUDGET: complex — fan out",
		);
		expect(composeBrief({ ...opts, effort: "simple" })).toContain(
			"EFFORT BUDGET: simple",
		);
		expect(composeBrief({ ...opts })).not.toContain("EFFORT BUDGET");
	});
});

// W254: pointer-grade injection — composeBrief renders intel sections only
// when an intel object rides; headers never pad an empty map (pointer
// discipline, hooks/lib/lanes/brief-intel.ts renderIntel).
describe("brief intel (W254 pointer-grade injection)", () => {
	const base = {
		item: "W140",
		showOut: "◐ W140 READY  sample item",
		sid: "autow140",
		branch: "suspenders/W140",
		worktree: "/tmp/nowhere/.worktrees/W140",
		capsule: null,
	};
	test("composeBrief renders intel sections, omits without", () => {
		const fresh = composeBrief(base);
		expect(fresh).not.toContain("FILE MAP");
		expect(fresh).not.toContain("DONE DEFINITION");
		const withIntel = composeBrief({
			...base,
			intel: {
				fileMap: ["- src/x.ts:1 — matched: foo"],
				doneDigest: ["Done when gates pass green."],
			},
		});
		expect(withIntel).toContain("FILE MAP (pointer-grade");
		expect(withIntel).toContain("- src/x.ts:1 — matched: foo");
		expect(withIntel).toContain("DONE DEFINITION (digest");
	});
});

describe("pool parsing", () => {
	test("parseReady reads renderRow rows; owner-gated titles skip", () => {
		const rows = [
			"\x1b[36m  · W140   build the thing\x1b[0m",
			"  · W141   OWNER-GATED: wait for owner",
			"  ⚠ W142   blocked row (not READY glyph)",
		].join("\n");
		const parsed = parseReady(rows);
		expect(parsed.map((r) => r.id)).toEqual(["W140", "W141"]);
		expect(parsed[1].title).toContain("OWNER-GATED");
		expect(isOwnerGated(parsed[1].title)).toBe(true);
		expect(isOwnerGated(parsed[0].title)).toBe(false);
		expect(isOwnerGated("notification fan-out — NEED_DECISION events")).toBe(
			false,
		);
		expect(isOwnerGated("coord paused event: target real sid")).toBe(false);
	});

	test("parseReady W494: an id that fills the pad emits no separator — still parsed", () => {
		// synthetic: W999999 is 7 chars (pad width) so the renderer's gap
		// vanishes; the id class must stop at the first non-id char.
		const rows = [
			"  · W999999synthetic title glued to the pad edge",
			"  · W12   short id keeps its padded gap",
			"  · W999999",
		].join("\n");
		const parsed = parseReady(rows);
		expect(parsed.map((r) => r.id)).toEqual(["W999999", "W12", "W999999"]);
		expect(parsed[0].title).toBe("synthetic title glued to the pad edge");
		expect(parsed[1].title).toBe("short id keeps its padded gap");
		expect(parsed[2].title).toBe("");
	});

	test("parseReady W619: the ⟨needs …⟩ suffix parses to requires", () => {
		const rows = [
			"  · W140   build the thing ⟨needs shell,fs⟩",
			"  · W141   plain item",
			"  · W142   spaced needs ⟨needs vision, browser⟩",
		].join("\n");
		const parsed = parseReady(rows);
		expect(parsed[0].requires).toEqual(["shell", "fs"]);
		expect(parsed[1].requires).toEqual([]);
		expect(parsed[2].requires).toEqual(["vision", "browser"]);
	});
});

describe("W619 capability gate", () => {
	test("mismatched rows skip with the missing caps named; starved aggregates", () => {
		const rows = [
			{ id: "W1", requires: ["shell"] },
			{ id: "W2", requires: [] },
			{ id: "W3", requires: ["vision"] },
		];
		const gate = capabilityGate(
			rows,
			(sid) => (sid === "W1" ? [] : ["shell", "vision"]),
			(id) => id,
		);
		expect(gate.dispatchable.map((r) => r.id)).toEqual(["W2", "W3"]);
		expect(gate.skips).toHaveLength(1);
		expect(gate.skips[0]).toContain("W1");
		expect(gate.skips[0]).toContain("missing [shell]");
		expect(gate.starved.get("shell")).toEqual(["W1"]);
	});
});

describe("must/prefer chain (W813 position law: later directives win, CLI-agnostic)", () => {
	test("multiple must=/prefer= lines: attempt 0 rides the LAST directive, same-bin tail rides --fallback-model", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			["must=opus", "must=sonnet", "prefer=fable", ""].join("\n"),
		);
		const added = tool("work.ts", "add", "chain sample item");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const out = dispatch("--dry-run", "--item", id);
		expect(out.out).toContain("DRY chain attempt 0/2 -> fable");
		expect(out.out).toContain("(+fallback-model sonnet,opus)");
	});

	test("a dead/resumed lane advances to the next chain entry, including across a bin switch", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			["must=opus", "must=copilot", ""].join("\n"),
		);
		const added = tool("work.ts", "add", "chain resume item");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		// W813: the later must (copilot, line 2) outranks opus — attempt 0
		// rides copilot; opus (a different bin) is only reachable by the NEXT
		// dispatch, same sid
		const first = dispatch("--dry-run", "--item", id);
		expect(first.out).toContain("DRY chain attempt 0/1 -> copilot");
		expect(first.out).not.toContain("fallback-model");
		rmSync(join(REPO, ".prefer"));
	});
});

// W874: untracked node_modules at any depth is dependency debris, never
// unbanked residue — fresh spawns that install deps must stay dispatch-ready.
describe("residueOf (W874)", () => {
	const git = (wt: string, ...args: string[]) =>
		spawnSync("/usr/bin/git", args, { cwd: wt, encoding: "utf8" });
	test("untracked node_modules (root + nested) is dispatch-ready; a dirty file still blocks", () => {
		const wt = join(REPO, "w874-residue-fixture");
		mkdirSync(join(wt, "packages", "suspenders"), { recursive: true });
		try {
			git(wt, "init", "-q");
			git(wt, "config", "user.email", "t@t.invalid");
			git(wt, "config", "user.name", "t");
			writeFileSync(join(wt, "tracked.ts"), "export const w874 = true;\n");
			// tracked so the nested install surfaces at its real depth, not
			// collapsed as "?? packages/"
			writeFileSync(
				join(wt, "packages", "suspenders", "pkg.ts"),
				"export const pkg = true;\n",
			);
			git(wt, "add", "tracked.ts", "packages/suspenders/pkg.ts");
			git(wt, "commit", "-qm", "fixture");
			expect(residueOf(wt)).toBe("");
			mkdirSync(join(wt, "node_modules"), { recursive: true });
			writeFileSync(join(wt, "node_modules", "dep.js"), "x");
			mkdirSync(join(wt, "packages", "suspenders", "node_modules"), {
				recursive: true,
			});
			writeFileSync(
				join(wt, "packages", "suspenders", "node_modules", "dep.js"),
				"x",
			);
			expect(residueOf(wt)).toBe("");
			writeFileSync(join(wt, "tracked.ts"), "export const w874 = false;\n");
			expect(residueOf(wt)).toContain("tracked.ts");
		} finally {
			rmSync(wt, { recursive: true, force: true });
		}
	});
});
