// brief composition (resume context, inbox contract, effort budget),

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityGate, composeBrief, isOwnerGated, parseReady } from "../../scripts/dispatch-next.ts";
import {
	REPO,
	tool,
	dispatch,
} from "./fixtures.ts";

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

describe("must/prefer chain (owner directive 2026-10-03: sequential, CLI-agnostic)", () => {
	test("multiple must=/prefer= lines: attempt 0 picks the first must, trailing same-bin entries ride --fallback-model", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			["must=opus", "must=sonnet", "prefer=fable", ""].join("\n"),
		);
		const added = tool("work.ts", "add", "chain sample item");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const out = dispatch("--dry-run", "--item", id);
		expect(out.out).toContain("DRY chain attempt 0/2 -> opus");
		expect(out.out).toContain("(+fallback-model sonnet,fable)");
	});

	test("a dead/resumed lane advances to the next chain entry, including across a bin switch", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			["must=opus", "must=copilot", ""].join("\n"),
		);
		const added = tool("work.ts", "add", "chain resume item");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		// attempt 0: opus, no same-bin tail to fall back on (copilot is a
		// different bin — only reachable by the NEXT dispatch, same sid)
		const first = dispatch("--dry-run", "--item", id);
		expect(first.out).toContain("DRY chain attempt 0/1 -> opus");
		expect(first.out).not.toContain("fallback-model");
		rmSync(join(REPO, ".prefer"));
	});
});

