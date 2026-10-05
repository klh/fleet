import { describe, expect, test } from "bun:test";
import { kappa } from "../tools/stats.ts";
import { validateRecord, loadSchema } from "../tools/label.ts";

const schema = loadSchema();

const validSeed = {
	id: "BLAM-9001",
	date: "2026-09-28",
	title: "test seed",
	summary: "test summary",
	crash_class: "concurrency-race",
	subclass: "registry-lag",
	severity: {
		data_loss_commits: 0,
		false_blocks: 2,
		wall_clock_lost_min: 40,
		undetected_min: 0,
	},
	detection: { how: "log correlation", time_min: 43, automated: false },
	recovery: {
		action: "grace window shipped",
		time_min: 15,
		permanent_fix: "evidence-based retire grace",
	},
	mitigations: ["reference-before-delete"],
	confidence: "high",
};

describe("validateRecord", () => {
	test("accepts a valid record", () => {
		const errs = validateRecord(validSeed, schema);
		expect(errs).toEqual([]);
	});

	test("rejects wrong class enum", () => {
		const bad = { ...validSeed, crash_class: "oops" };
		expect(validateRecord(bad, schema).length).toBeGreaterThan(0);
	});

	test("rejects missing required field", () => {
		const bad = structuredClone(validSeed);
		delete (bad as Record<string, unknown>).severity;
		expect(validateRecord(bad, schema).length).toBeGreaterThan(0);
	});

	test("rejects unknown field", () => {
		const bad = { ...validSeed, hax: 1 };
		expect(validateRecord(bad, schema).length).toBeGreaterThan(0);
	});

	test("rejects bad id pattern", () => {
		const bad = { ...validSeed, id: "XX-1" };
		expect(validateRecord(bad, schema).length).toBeGreaterThan(0);
	});
});

describe("kappa", () => {
	test("perfect agreement is 1", () => {
		expect(kappa(["C", "C", "R"], ["C", "C", "R"])).toBe(1);
	});

	test("classic zero-agreement case is 0", () => {
		expect(kappa(["A", "A", "B", "B"], ["A", "B", "A", "B"])).toBe(0);
	});

	test("rejects unequal lengths", () => {
		expect(() => kappa(["A"], [])).toThrow();
	});
});
