// lane-effort-policy.test.ts — W1140: the lane effort policy — parse, conf
// chain, classification, the two-stage default, and the dispatch pin.
import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effortForPriority } from "../hooks/lib/lanes/lane-effort.ts";
import {
	dispatchLaneEffort,
	EFFORT_POLICY_DEFAULTS,
	effortDecision,
	effortItemFromStore,
	effortPolicyLine,
	laneEffortBriefLine,
	loadEffortPolicy,
	parseEffortPolicy,
} from "../hooks/lib/lanes/lane-effort-policy.ts";

test.describe("parseEffortPolicy", () => {
	test("parses a full JSON policy with regex rules", () => {
		const p = parseEffortPolicy(
			JSON.stringify({
				version: 1,
				default: "two-stage",
				single_effort: "medium",
				classify: [
					{
						when: {
							tags_any: ["verification", "security", "edgecase", "hardware"],
						},
						effort: "high",
					},
					{
						when: { title_re: "\\b(verify|audit|security)\\b" },
						effort: "high",
					},
					{ when: { tags_any: ["research", "exploration"] }, effort: "medium" },
					{
						when: { tags_any: ["crud", "rulebook", "mechanical"] },
						effort: "low",
					},
				],
				two_stage: { implement: "low", verify: "high" },
				budgets: { low: 100000, medium: 200000, high: 300000 },
			}),
		);
		expect(p.version).toBe(1);
		expect(p.default).toBe("two-stage");
		expect(p.classify.length).toBe(4);
		expect(p.classify[0].when.tags_any).toEqual([
			"verification",
			"security",
			"edgecase",
			"hardware",
		]);
		expect(p.two_stage).toEqual({ implement: "low", verify: "high" });
		expect(p.budgets.high).toBe(300000);
	});

	test("rejects bad version, effort words, regexes, and rule shapes", () => {
		expect(() =>
			parseEffortPolicy(JSON.stringify({ version: 2, default: "two-stage" })),
		).toThrow(/version: 1 only/);
		expect(() =>
			parseEffortPolicy(
				JSON.stringify({
					classify: [{ when: { tags_any: ["security"] }, effort: "max" }],
				}),
			),
		).toThrow(/effort: must be low\|medium\|high/);
		expect(() =>
			parseEffortPolicy(
				JSON.stringify({
					classify: [
						{ when: { title_re: "(\\b(unterminated" }, effort: "low" },
					],
				}),
			),
		).toThrow(/invalid regex/);
		expect(() =>
			parseEffortPolicy(JSON.stringify({ classify: [{ effort: "low" }] })),
		).toThrow(/when: needs/);
		expect(() =>
			parseEffortPolicy(JSON.stringify({ budgets: { max: 5 } })),
		).toThrow(/budgets\.max: unknown effort word/);
		expect(() =>
			parseEffortPolicy(JSON.stringify({ budgets: { low: -1 } })),
		).toThrow(/must be a number >= 0/);
	});

	test("accepts JSON and the built-in defaults verbatim", () => {
		const p = parseEffortPolicy(JSON.stringify(EFFORT_POLICY_DEFAULTS));
		expect(p.classify.length).toBe(EFFORT_POLICY_DEFAULTS.classify.length);
	});
});

test.describe("loadEffortPolicy (conf chain)", () => {
	const HOME = mkdtempSync(join(tmpdir(), "effort-policy-"));
	test.afterEach(() => {
		rmSync(join(HOME, ".claude"), { recursive: true, force: true });
	});

	const confDir = join(HOME, ".claude/local-llm");
	const writeConf = (name: string, text: string): string => {
		mkdirSync(confDir, { recursive: true });
		const p = join(confDir, name);
		writeFileSync(p, text);
		return p;
	};

	test("absent conf → built-in defaults", () => {
		const r = loadEffortPolicy({ env: {}, home: HOME });
		expect(r.source).toBe("default");
		expect(r.warning).toBeNull();
		expect(r.policy.classify.length).toBe(
			EFFORT_POLICY_DEFAULTS.classify.length,
		);
	});

	test("runtime json beats legacy name; env pin beats both", () => {
		writeConf(
			"lane-effort-policy.yaml",
			JSON.stringify({
				version: 1,
				classify: [{ when: { tags_any: ["aaab"] }, effort: "low" }],
			}),
		);
		writeConf(
			"lane-effort-policy.json",
			JSON.stringify({
				version: 1,
				classify: [{ when: { tags_any: ["zzz9"] }, effort: "high" }],
			}),
		);
		const r = loadEffortPolicy({ env: {}, home: HOME });
		expect(r.source).toBe("runtime");
		expect(r.path).toContain(".json");
		expect(r.policy.classify[0].when.tags_any).toEqual(["zzz9"]);
		// a legacy-named pin still resolves — its content must be JSON (W1253)
		const pin = writeConf("pinned.yaml", JSON.stringify({ default: "single" }));
		const envd = loadEffortPolicy({
			env: { SUSPENDERS_EFFORT_POLICY: pin },
			home: HOME,
		});
		expect(envd.source).toBe("env");
		expect(envd.policy.default).toBe("single");
	});

	test("invalid conf → defaults + surfaced warning (never silent)", () => {
		writeConf("lane-effort-policy.json", "{not json");
		const r = loadEffortPolicy({ env: {}, home: HOME });
		expect(r.source).toBe("default");
		expect(r.policy.default).toBe("two-stage");
		expect(r.warning).toContain("parse failed");
	});
});

test.describe("classification + decision", () => {
	test("tags/title rules fire first-match-wins; research → medium", () => {
		const p = EFFORT_POLICY_DEFAULTS;
		expect(effortDecision(p, { tags: "security" }).effort).toBe("high");
		expect(
			effortDecision(p, { tags: null, title: "Audit the token ladder" }).effort,
		).toBe("high");
		expect(effortDecision(p, { tags: "research" }).matched).toContain(
			"tags_any:research",
		);
		expect(effortDecision(p, { tags: "fleet,crud" }).effort).toBe("low");
		// a matched rule pins ONE stage — no verify leg
		expect(effortDecision(p, { tags: "security" }).verifyEffort).toBeNull();
	});

	test("unmatched → two-stage default (implement low, verify high)", () => {
		const d = effortDecision(EFFORT_POLICY_DEFAULTS, {
			title: "Add a nav field",
		});
		expect(d.effort).toBe("low");
		expect(d.verifyEffort).toBe("high");
		expect(d.matched).toBeNull();
		expect(d.budget).toBe(100_000);
	});

	test("single mode pins one effort for unmatched items", () => {
		const p = parseEffortPolicy(
			JSON.stringify({ default: "single", single_effort: "medium" }),
		);
		const d = effortDecision(p, { title: "Add a nav field" });
		expect(d.effort).toBe("medium");
		expect(d.verifyEffort).toBeNull();
	});
});

test.describe("store-backed pin (dispatchLaneEffort)", () => {
	const db = (): Database => {
		const d = new Database(":memory:");
		d.run(
			"CREATE TABLE work_items (project TEXT, id TEXT, tags TEXT, title TEXT, description TEXT)",
		);
		return d;
	};

	test("classified rows pin by rule; absent row falls back to medium", () => {
		const d = db();
		const ins = (id: string, tags: string | null, title: string): void =>
			d
				.prepare(
					"INSERT INTO work_items (project, id, tags, title, description) VALUES ('p', ?, ?, ?, 'desc')",
				)
				.run(id, tags, title);
		ins("W1", "security", "Fix the gate");
		ins("W2", "research", "Explore options");
		ins("W3", null, "Add a field");
		expect(dispatchLaneEffort(d, "p", "W1")).toBe("high");
		expect(dispatchLaneEffort(d, "p", "W2")).toBe("medium");
		expect(dispatchLaneEffort(d, "p", "W3")).toBe("low"); // two-stage
		expect(dispatchLaneEffort(d, "p", "MISSING")).toBe(effortForPriority(null));
		d.close();
	});
});

test.describe("brief line + store read", () => {
	const rowStore = (
		rows: Record<string, { tags: string; title: string }>,
	): object => ({
		query: (_sql: string) => ({
			get: (...params: unknown[]) => rows[params[1] as string] ?? null,
		}),
	});

	test("effortItemFromStore maps the row; missing row → null", () => {
		const s = rowStore({ W1: { tags: "security", title: "Fix" } });
		expect(effortItemFromStore(s, "p", "W1")).toEqual({
			tags: "security",
			title: "Fix",
			desc: null,
		});
		expect(effortItemFromStore(s, "p", "GHOST")).toBeNull();
	});

	test("laneEffortBriefLine renders the verdict; no row → null", () => {
		// projectIdentity needs a real git tree; the fleet worktree root works
		// from any checkout (the fake store keys rows on item, not project).
		const repo = join(import.meta.dir, "../../..");
		const s = rowStore({
			W9: { tags: "verification", title: "Verify the ladder" },
		});
		const line = laneEffortBriefLine(repo, "W9", {
			store: s,
			env: {},
			home: "/nonexistent-home",
		});
		expect(line).toContain("EFFORT POLICY: pinned high");
		expect(line).toContain("classified tags_any:verification");
		expect(
			laneEffortBriefLine(repo, "GHOST", {
				store: s,
				env: {},
				home: "/nonexistent-home",
			}),
		).toBeNull();
	});

	test("effortPolicyLine formats the budget baseline", () => {
		const line = effortPolicyLine({
			effort: "low",
			verifyEffort: "high",
			matched: null,
			budget: 100_000,
		});
		expect(line).toContain("pinned low");
		expect(line).toContain("two-stage default");
		expect(line).toContain("100k tokens");
	});
});
