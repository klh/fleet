// race-policy.test.ts — W1143: the race policy — parse, conf chain,
// classification, the raced decision, and the brief line.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyRace,
	loadRacePolicy,
	RACE_LANES_CAP,
	RACE_OFF,
	raceDecision,
	racePolicyLine,
	RACE_POLICY_DEFAULTS,
	parseRacePolicy,
} from "../hooks/lib/race-policy.ts";

describe("parseRacePolicy", () => {
	test("absent keys ride the defaults; built-in defaults parse verbatim", () => {
		expect(parseRacePolicy("version: 1\n")).toEqual(RACE_POLICY_DEFAULTS);
		expect(parseRacePolicy(JSON.stringify(RACE_POLICY_DEFAULTS))).toEqual(
			RACE_POLICY_DEFAULTS,
		);
	});

	test("parses a full YAML policy with rules, ports, temp, skeptic", () => {
		const p = parseRacePolicy(`version: 1
default_lanes: 2
max_lanes: 4
attempt_port: 8901
attempt_temp: 0.9
judge_port: 8903
skeptic: false
classify:
  - when: { tags_any: [benchmark, exploratory] }
    lanes: 3
  - when:
      title_re: \\b(spike|po[c])\\b
    lanes: 2
`);
		expect(p.version).toBe(1);
		expect(p.default_lanes).toBe(2);
		expect(p.max_lanes).toBe(4);
		expect(p.attempt_port).toBe(8901);
		expect(p.attempt_temp).toBe(0.9);
		expect(p.judge_port).toBe(8903);
		expect(p.skeptic).toBe(false);
		expect(p.classify.length).toBe(2);
		expect(p.classify[0].when.tags_any).toEqual(["benchmark", "exploratory"]);
		expect(p.classify[1].when.title_re).toBe("\\b(spike|po[c])\\b");
	});

	test("JSON path parses identically", () => {
		const p = parseRacePolicy(
			JSON.stringify({
				version: 1,
				classify: [
					{ when: { tags_any: ["benchmark"] }, lanes: 3 },
					{ when: { title_re: "\\bspike\\b" }, lanes: 2 },
				],
			}),
		);
		expect(p.max_lanes).toBe(3);
		expect(p.skeptic).toBe(true);
		expect(p.classify[0].lanes).toBe(3);
		expect(p.classify[1].when.title_re).toBe("\\bspike\\b");
	});

	test("rejects bad version, lanes, ports, temp, and rule shapes", () => {
		expect(() => parseRacePolicy("version: 2\n")).toThrow(/version: 1 only/);
		expect(() => parseRacePolicy("default_lanes: 0\n")).toThrow(
			/default_lanes: must be an integer/,
		);
		expect(() => parseRacePolicy("max_lanes: 9\n")).toThrow(
			/max_lanes: must be an integer/,
		);
		expect(() =>
			parseRacePolicy("classify:\n  - when: { tags_any: [x] }\n    lanes: 0\n"),
		).toThrow(/classify\[0\].lanes: must be an integer/);
		expect(() => parseRacePolicy("judge_port: 70000\n")).toThrow(
			/judge_port: must be a port/,
		);
		expect(() => parseRacePolicy("attempt_temp: 2.5\n")).toThrow(
			/attempt_temp: must be a number 0..2/,
		);
		expect(() => parseRacePolicy("classify:\n  - lanes: 2\n")).toThrow(
			/when: needs tags_any/,
		);
		expect(() =>
			parseRacePolicy("classify:\n  - when: { tags_any: [] }\n    lanes: 2\n"),
		).toThrow(/tags_any: must be a non-empty string list/);
		expect(() =>
			parseRacePolicy(
				'classify:\n  - when: { title_re: "(unterminated" }\n    lanes: 2\n',
			),
		).toThrow(/invalid regex/);
		expect(() => parseRacePolicy("- a\n- b\n")).toThrow(/must be a mapping/);
	});
});

describe("loadRacePolicy (conf chain)", () => {
	const HOME = mkdtempSync(join(tmpdir(), "race-policy-"));
	afterEach(() => {
		rmSync(join(HOME, ".claude"), { recursive: true, force: true });
	});

	const confDir = join(HOME, ".claude/local-llm");
	const writeConf = (name: string, text: string): string => {
		mkdirSync(confDir, { recursive: true });
		const p = join(confDir, name);
		writeFileSync(p, text);
		return p;
	};

	test("absent conf → built-in defaults (racing OFF)", () => {
		const r = loadRacePolicy({ env: {}, home: HOME });
		expect(r.source).toBe("default");
		expect(r.warning).toBeNull();
		expect(r.policy.default_lanes).toBe(RACE_OFF);
		expect(r.policy.max_lanes).toBe(3);
		expect(r.policy.classify).toEqual([]);
	});

	test("runtime json beats yaml; env pin beats both; empty env = unset", () => {
		writeConf(
			"race-policy.yaml",
			"classify:\n  - when: { tags_any: [aaab] }\n    lanes: 2\n",
		);
		writeConf(
			"race-policy.json",
			JSON.stringify({
				version: 1,
				classify: [{ when: { tags_any: ["zzz9"] }, lanes: 3 }],
			}),
		);
		const r = loadRacePolicy({ env: {}, home: HOME });
		expect(r.source).toBe("runtime");
		expect(r.path).toContain(".json");
		expect(r.policy.classify[0].when.tags_any).toEqual(["zzz9"]);
		const pin = writeConf("pinned.yaml", "default_lanes: 2\n");
		const envd = loadRacePolicy({
			env: { SUSPENDERS_RACE_POLICY: pin },
			home: HOME,
		});
		expect(envd.source).toBe("env");
		expect(envd.policy.default_lanes).toBe(2);
		const unset = loadRacePolicy({
			env: { SUSPENDERS_RACE_POLICY: "" },
			home: HOME,
		});
		expect(unset.source).toBe("runtime");
	});

	test("invalid conf → defaults + surfaced warning (never silent)", () => {
		writeConf("race-policy.yaml", "default_lanes: 0\n");
		const r = loadRacePolicy({ env: {}, home: HOME });
		expect(r.source).toBe("default");
		expect(r.policy.default_lanes).toBe(RACE_OFF);
		expect(r.warning).toContain("default_lanes");
	});
});

describe("classification + decision", () => {
	test("rules fire first-match-wins, case-insensitive on tags", () => {
		const p = parseRacePolicy(`version: 1
max_lanes: 4
classify:
  - when: { tags_any: [race, benchmark] }
    lanes: 3
  - when: { title_re: \\b(spike|explor)\\b }
    lanes: 2
`);
		expect(classifyRace(p, { tags: "Benchmark,crud" })).toEqual({
			lanes: 3,
			matched: "tags_any:race,benchmark",
		});
		expect(
			classifyRace(p, { title: "Exploratory spike on the ladder" }),
		).toEqual({ lanes: 2, matched: "title_re" });
		// first match wins: an item matching two rules rides the earlier one
		expect(classifyRace(p, { tags: "race", title: "spike now" })).toEqual({
			lanes: 3,
			matched: "tags_any:race,benchmark",
		});
	});

	test("parse refuses >cap lanes; decision clamps to max_lanes", () => {
		expect(() =>
			parseRacePolicy(
				`classify:\n  - when: { tags_any: [race] }\n    lanes: ${RACE_LANES_CAP + 1}\n`,
			),
		).toThrow(/must be an integer 1..8/);
		const ok = parseRacePolicy(`version: 1
default_lanes: ${RACE_LANES_CAP}
max_lanes: 3
classify:
  - when: { tags_any: [race] }
    lanes: ${RACE_LANES_CAP}
`);
		expect(classifyRace(ok, { tags: "race" }).lanes).toBe(3);
		expect(classifyRace(ok, {}).lanes).toBe(3);
		expect(classifyRace(ok, {}).matched).toBeNull();
	});

	test("raceDecision carries ports/temp/skeptic; raced = lanes > 1", () => {
		const off = raceDecision(RACE_POLICY_DEFAULTS, {});
		expect(off.lanes).toBe(1);
		expect(off.raced).toBe(false);
		expect(off.judgePort).toBe(8903);
		expect(off.attemptPort).toBe(8902);
		expect(off.attemptTemp).toBe(0.7);
		expect(off.skeptic).toBe(true);
		expect(off.matched).toBeNull();
		const p = parseRacePolicy(`version: 1
default_lanes: 1
classify:
  - when: { tags_any: [race] }
    lanes: 3
`);
		const on = raceDecision(p, { tags: "race" });
		expect(on.raced).toBe(true);
		expect(on.lanes).toBe(3);
		const unmatched = raceDecision(p, { tags: "crud" });
		expect(unmatched.raced).toBe(false);
		expect(unmatched.matched).toBeNull();
	});

	test("racePolicyLine renders the ON and OFF verdicts", () => {
		const p = parseRacePolicy(
			"classify:\n  - when: { tags_any: [race] }\n    lanes: 2\n",
		);
		const on = racePolicyLine(raceDecision(p, { tags: "race" }));
		expect(on).toContain("race 2 cheap attempts");
		expect(on).toContain("judge :8903 + skeptic");
		expect(on).toContain("tags_any:race");
		const off = racePolicyLine(raceDecision(RACE_POLICY_DEFAULTS, {}));
		expect(off).toContain("off — single lane");
	});
});
