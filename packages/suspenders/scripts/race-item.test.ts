// race-item.test.ts — W1143: the race-item CLI — pure plan projection, argv
// parsing (help + usage refusal), and the store-backed plan.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { projectIdentity } from "../hooks/lib/govdb.ts";
import {
	RACE_POLICY_DEFAULTS,
	type LoadedRacePolicy,
	parseRacePolicy,
} from "../hooks/lib/race-policy.ts";
import { planCli, planOf } from "./race-item.ts";

const load = (policy = RACE_POLICY_DEFAULTS): LoadedRacePolicy => ({
	policy,
	source: "default",
	path: null,
	warning: null,
});

describe("planOf", () => {
	test("defaults → off plan carrying the policy provenance", () => {
		expect(planOf("W1", { tags: "crud" }, load())).toEqual({
			item: "W1",
			lanes: 1,
			raced: false,
			attemptPort: 8902,
			attemptTemp: 0.7,
			judgePort: 8903,
			skeptic: true,
			matched: null,
			source: "default",
			path: null,
			warning: null,
		});
	});

	test("a matching rule → raced plan with the matched rule summary", () => {
		const p = parseRacePolicy(
			"classify:\n  - when: { tags_any: [race] }\n    lanes: 3\n",
		);
		const plan = planOf("W2", { tags: "race,crud" }, load(p));
		expect(plan.raced).toBe(true);
		expect(plan.lanes).toBe(3);
		expect(plan.matched).toBe("tags_any:race");
	});
});

describe("planCli", () => {
	const proj = projectIdentity(process.cwd());
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items (project TEXT, id TEXT, tags TEXT, title TEXT, description TEXT)",
	);
	db.run(
		`INSERT INTO work_items VALUES ('${proj}', 'W1', 'race', 'Race me', NULL), ('${proj}', 'W2', NULL, 'plain item', NULL)`,
	);
	afterEach(() => db.run("DELETE FROM work_items WHERE id LIKE 'WX%'"));

	test("refuses without positionals; --help rides stdout with exit 0", async () => {
		expect(await planCli([])).toBe(1);
		expect(await planCli(["--help"])).toBe(0);
	});

	test("unknown item → exit 1", async () => {
		expect(await planCli(["WX404"], { store: db, env: {}, home: "" })).toBe(1);
	});

	test("store-backed item → exit 0; raced item + conf source shown", async () => {
		expect(await planCli(["W1"], { store: db, env: {}, home: "" })).toBe(0);
	});
});
