// prompt-bench tests — corpus determinism + scorer behavior (W368).
import { test, expect } from "@playwright/test";
import { buildCorpus } from "./prompt-bench-corpus.ts";
import {
	extractIdents,
	scoreCompress,
	scoreEnhance,
	median,
} from "./prompt-bench-score.ts";

test.describe("prompt-bench corpus", () => {
	test("same seed → byte-identical corpus", () => {
		const a = buildCorpus(20, 42);
		const b = buildCorpus(20, 42);
		expect(a).toEqual(b);
	});
	test("different seed → different corpus", () => {
		const a = buildCorpus(20, 42);
		const b = buildCorpus(20, 43);
		expect(a).not.toEqual(b);
	});
	test("130 seeds: unique verbose + terse, tokens present in both forms", () => {
		const c = buildCorpus(130);
		expect(c.length).toBe(130);
		const v = new Set(c.map((s) => s.verbose));
		const t = new Set(c.map((s) => s.terse));
		expect(v.size).toBe(130);
		expect(t.size).toBe(130);
		for (const s of c) {
			for (const tok of s.tokens) {
				expect(s.verbose.includes(tok)).toBe(true);
				expect(s.terse.includes(tok)).toBe(true);
			}
		}
	});
});

test.describe("prompt-bench scorer", () => {
	const seed = buildCorpus(1, 7)[0];
	test("perfect compression (echo of a tightened form) scores high", () => {
		// a faithful compress keeps tokens, drops filler
		const faithful = seed.verbose
			.replace("Hi — could you please ", "")
			.replace("?", "")
			.replace(
				"Thanks so much in advance; this is important to the fleet. ",
				"",
			)
			.replace(
				"It is worth noting that the previous attempt at this prompt was written in a hurry. ",
				"",
			);
		const s = scoreCompress(seed, faithful);
		expect(s.retention).toBe(1);
		expect(s.additions).toBe(0);
		expect(s.score).toBeGreaterThan(80);
	});
	test("dropping tokens tanks retention", () => {
		const s = scoreCompress(
			seed,
			seed.verbose.replace(seed.tokens[0], "the module"),
		);
		expect(s.retention).toBeLessThan(1);
	});
	test("invented identifiers count as additions", () => {
		const s = scoreCompress(seed, `${seed.terse} see /etc/hallucinated.yaml`);
		expect(s.additions).toBeGreaterThan(0);
	});
	test("enhance: faithful expansion scores high, service-desk opener penalized", () => {
		// keeps every token, no additions, sane length → full marks
		const good = `Please handle: ${seed.terse}`;
		const s1 = scoreEnhance(seed, good);
		expect(s1.retention).toBe(1);
		expect(s1.additions).toBe(0);
		expect(s1.score).toBeGreaterThanOrEqual(95);
		const opener = `Sure! ${good}`;
		expect(scoreEnhance(seed, opener).secondary).toBe(0.5);
	});
	test("extractIdents finds paths, flags, hex, numbers", () => {
		const idents = extractIdents(
			"run bun test --dry-run on packages/belt/bin/router-shim.ts trace a1b2c3d4 port 8902 at 2500ms",
		);
		expect(idents.has("packages/belt/bin/router-shim.ts")).toBe(true);
		expect(idents.has("--dry-run")).toBe(true);
		expect(idents.has("a1b2c3d4")).toBe(true);
		expect(idents.has("8902")).toBe(true);
	});
	test("median basics", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
	});
});
