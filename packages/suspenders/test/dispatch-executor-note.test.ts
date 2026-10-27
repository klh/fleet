// scripts/lib/dispatch-executor-note.test.ts — W1353: the quoted-prefer-without-chain WARN and the chosen executor+model disclosure.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chosenExecutor,
	chosenExecutorLine,
	chosenExecutorReport,
	DEFAULT_LANE_MODEL,
	laneModelOf,
	quotedPreferWarning,
} from "./dispatch-executor-note.ts";
import { execPick } from "./exec-chain.ts";
import { resolveRoutingPrefer } from "./prefer-routing.ts";

const HOME = mkdtempSync(join(tmpdir(), "w1353-home-"));
const TREE = mkdtempSync(join(tmpdir(), "w1353-tree-"));
const REPO = join(TREE, "somerepo");
mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
mkdirSync(REPO, { recursive: true });
writeFileSync(
	join(HOME, ".claude", "local-llm", "suspenders-board.json"),
	JSON.stringify({ default_executors: [] }),
);
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
	rmSync(TREE, { recursive: true, force: true });
});

const defaultPref = {
	source: "default",
	directive: "default",
	line: 0,
} as const;
const mustRouting = {
	prefer: null,
	must: "glm-5.3-flash",
	preferSource: null,
	mustSource: "/tree/.prefer",
};
const claudeDefault = { executor: "claude", model: "glm-5.3-flash" };
const chosenOf = (over: { hub?: string | null; route?: string | null } = {}) =>
	chosenExecutor({
		item: "W1",
		pick: { bin: "claude", model: null, preference: defaultPref },
		hub: over.hub ?? null,
		route: over.route ?? null,
		routing: mustRouting,
		repo: "/repo",
	});

describe("laneModelOf", () => {
	test("a pinned model wins; unpinned falls to the one default literal", () => {
		expect(laneModelOf({ model: "fable" })).toBe("fable");
		expect(laneModelOf({ model: null })).toBe(DEFAULT_LANE_MODEL);
		expect(laneModelOf({})).toBe(DEFAULT_LANE_MODEL);
		expect(DEFAULT_LANE_MODEL).toBe("glm-5.3-flash");
	});
});

describe("quotedPreferWarning", () => {
	test("quoted must + default pick names the value, its file, the executor+model chosen and the fix", () => {
		const w = quotedPreferWarning(
			mustRouting,
			defaultPref,
			claudeDefault,
			"/r",
		);
		expect(w?.startsWith("WARN — ")).toBe(true);
		expect(w).toContain('must="glm-5.3-flash" (/tree/.prefer)');
		expect(w).toContain("ROUTING-plane only");
		expect(w).toContain("DEFAULT ladder picked claude model glm-5.3-flash");
		expect(w).toContain("unquoted must=<model> in /r/.prefer");
	});

	test("prefer-only and both: every declared key is named", () => {
		const preferOnly = { ...mustRouting, must: null, mustSource: null };
		const p = {
			...preferOnly,
			prefer: "ikea llms",
			preferSource: "/t/.prefer",
		};
		expect(quotedPreferWarning(p, defaultPref, claudeDefault, "/r")).toContain(
			'prefer="ikea llms" (/t/.prefer)',
		);
		const both = {
			...mustRouting,
			prefer: "local",
			preferSource: "/b/.prefer",
		};
		const w = quotedPreferWarning(both, defaultPref, claudeDefault, "/r");
		expect(w).toContain('must="glm-5.3-flash"');
		expect(w).toContain('prefer="local"');
	});

	test("an executor-chain directive or the plaid posture silences it", () => {
		const chain = { source: "dotfile" } as const;
		expect(
			quotedPreferWarning(mustRouting, chain, claudeDefault, "/r"),
		).toBeNull();
		const plaid = { source: "posture" } as const;
		expect(
			quotedPreferWarning(mustRouting, plaid, claudeDefault, "/r"),
		).toBeNull();
	});

	test("no routing, or routing with neither key: null", () => {
		expect(
			quotedPreferWarning(undefined, defaultPref, claudeDefault, "/r"),
		).toBeNull();
		const none = { ...mustRouting, must: null, mustSource: null };
		expect(
			quotedPreferWarning(none, defaultPref, claudeDefault, "/r"),
		).toBeNull();
	});
});

describe("real parsers: a tree-level quoted .prefer reaches only the routing plane", () => {
	test("quoted must in the tree, no repo chain: execPick takes the default ladder and the row WARNs", () => {
		writeFileSync(join(TREE, ".prefer"), 'must = "glm-5.3-flash"\n');
		try {
			const routing = resolveRoutingPrefer(REPO);
			const pick = execPick(0, REPO);
			expect(routing.must).toBe("glm-5.3-flash");
			expect(pick.preference.source).toBe("default");
			const row = chosenExecutor({
				item: "W9",
				pick,
				hub: null,
				route: null,
				routing,
				repo: REPO,
			});
			expect(row.executor).toBe("claude");
			expect(row.model).toBe(DEFAULT_LANE_MODEL);
			expect(row.pickedBy).toBe("default ladder");
			expect(row.warn).toContain(
				`must="glm-5.3-flash" (${join(TREE, ".prefer")})`,
			);
			expect(row.warn).toContain(`in ${REPO}/.prefer`);
		} finally {
			rmSync(join(TREE, ".prefer"));
		}
	});

	test("an unquoted must= in the repo is the chain directive: no WARN, picked by that line", () => {
		writeFileSync(join(TREE, ".prefer"), 'must = "glm-5.3-flash"\n');
		writeFileSync(join(REPO, ".prefer"), "must=fable\n");
		try {
			const routing = resolveRoutingPrefer(REPO);
			const pick = execPick(0, REPO);
			const row = chosenExecutor({
				item: "W9",
				pick,
				hub: null,
				route: null,
				routing,
				repo: REPO,
			});
			expect(routing.must).toBe("glm-5.3-flash");
			expect(row.warn).toBeNull();
			expect(row.model).toBe("fable");
			expect(row.pickedBy).toBe(".prefer must line 1");
		} finally {
			rmSync(join(TREE, ".prefer"));
			rmSync(join(REPO, ".prefer"));
		}
	});
});

describe("chosenExecutor / chosenExecutorLine", () => {
	test("picked-by vocabulary: dotfile directive+line, default ladder, plaid posture, plaid route", () => {
		const pickedBy = (
			preference: {
				source: "dotfile" | "default" | "posture";
				directive: "must" | "prefer" | "can" | "default" | "posture";
				line: number;
			},
			route: string | null = null,
		) =>
			chosenExecutor({
				item: "W1",
				pick: { bin: "claude", preference },
				hub: null,
				route,
				routing: undefined,
				repo: "/r",
			}).pickedBy;
		expect(pickedBy({ source: "dotfile", directive: "prefer", line: 2 })).toBe(
			".prefer prefer line 2",
		);
		expect(pickedBy(defaultPref)).toBe("default ladder");
		expect(pickedBy({ source: "posture", directive: "posture", line: 0 })).toBe(
			"plaid posture",
		);
		expect(pickedBy(defaultPref, "zai-flash")).toBe("plaid route zai-flash");
	});

	test("a plaid route never WARNs; model is never blank; hub label rides the line", () => {
		expect(chosenOf({ route: "zai-flash" }).warn).toBeNull();
		const row = chosenOf({ hub: "nas" });
		expect(row.model).toBe(DEFAULT_LANE_MODEL);
		expect(chosenExecutorLine(row)).toBe(
			"executor W1: claude model=glm-5.3-flash hub=nas picked-by=default ladder",
		);
		expect(chosenExecutorLine(chosenOf())).toContain("hub=-");
	});
});

describe("chosenExecutorReport (the run-tail table)", () => {
	test("no rows: null", () => {
		expect(chosenExecutorReport([])).toBeNull();
	});

	test("header, aligned columns, WARN-flagged cell, each distinct WARN once", () => {
		const a = chosenOf();
		const b = { ...chosenOf({ hub: "nas" }), item: "W22" };
		const clean = {
			...a,
			item: "W3",
			model: "fable",
			warn: null,
			pickedBy: ".prefer must line 1",
		};
		const out = chosenExecutorReport([a, b, clean]) ?? "";
		const lines = out.split("\n");
		expect(lines[0]).toBe(
			"dispatch executors (what each lane actually launched with):",
		);
		expect(lines[1]).toMatch(/^ITEM\s+EXECUTOR\s+MODEL\s+HUB\s+PICKED BY$/);
		const col = (line: string | undefined, needle: string) =>
			line?.indexOf(needle);
		expect(col(lines[2], "claude")).toBe(col(lines[1], "EXECUTOR"));
		expect(col(lines[3], "nas")).toBe(col(lines[1], "HUB"));
		expect(col(lines[4], "fable")).toBe(col(lines[1], "MODEL"));
		expect(lines[2]).toContain(
			"default ladder (WARN: quoted .prefer, no chain)",
		);
		expect(lines[4]).not.toContain("WARN");
		expect(lines.filter((l) => l.startsWith("WARN — "))).toHaveLength(1);
	});
});
