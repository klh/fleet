// test/dispatch-next-parsing.test.ts — W1137: pure-parse units split out
// of dispatch-next.test.ts (the 1500-line decomposition; pure moves).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	capabilityGate,
	hubAttributionDecision,
	isOwnerGated,
	parseReady,
	residueOf,
} from "../scripts/dispatch-next.ts";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { REPO, tool, dispatch } = dispatchHarness(afterAll, {
	tag: "w145-dispatch",
	beltEnv: true,
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

// ─── hub-won attribution decisions (W615) ─────────────────────────────────
describe("hubAttributionDecision (W615)", () => {
	test("minted → governed: the hub's own scoped key attributes the lane", () => {
		const d = hubAttributionDecision({
			hasToken: true,
			minted: { key: "bksk_hub", keyId: "hubkey123456" },
			allowUngoverned: false,
		});
		expect(d).toEqual({
			mode: "governed",
			key: "bksk_hub",
			keyId: "hubkey123456",
		});
	});

	test("no hub credential → refuse, naming both credential surfaces", () => {
		const d = hubAttributionDecision({
			hasToken: false,
			minted: null,
			allowUngoverned: false,
		});
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") {
			expect(d.why).toContain("SUSPENDERS_HUB_<LABEL>_TOKEN");
			expect(d.why).toContain("hubs.json token");
		}
	});

	test("mint failure (credential present) → refuse (W463 stands at hubs too)", () => {
		const d = hubAttributionDecision({
			hasToken: true,
			minted: null,
			allowUngoverned: false,
		});
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") expect(d.why).toContain("mint failed");
	});

	test("--allow-ungoverned keeps the hub pin: rides the hub UNATTRIBUTED", () => {
		const d = hubAttributionDecision({
			hasToken: false,
			minted: null,
			allowUngoverned: true,
		});
		expect(d.mode).toBe("ungoverned-override");
		if (d.mode === "ungoverned-override")
			expect(d.note).toContain("rides the hub unattributed");
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
