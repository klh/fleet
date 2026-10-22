// bench/w1143/tournament.test.ts — pure-logic tests: the judge transport is
// injected, so nothing here touches a live tier.
import { describe, expect, test } from "bun:test";
import {
	pairPrompt,
	parsePair,
	parseSkeptic,
	runTournament,
	skepticPrompt,
	type Attempt,
	type JudgeCall,
} from "./tournament.ts";

const ATTEMPTS: Attempt[] = [
	{ id: "a1", answer: "first" },
	{ id: "a2", answer: "second" },
	{ id: "a3", answer: "third" },
];
const scripted = (replies: string[]): JudgeCall => {
	let i = 0;
	return async () => replies[i++] ?? "{}";
};
/** Expected tally recomputed from a tournament's own comparisons. */
const tallyOf = (
	result: Awaited<ReturnType<typeof runTournament>>,
): Map<string, number> => {
	const t = new Map<string, number>();
	for (const c of result.comparisons) {
		const wid = c.winner === "A" ? c.aSlot : c.winner === "B" ? c.bSlot : null;
		if (wid) t.set(wid, (t.get(wid) ?? 0) + 1);
		else {
			t.set(c.aSlot, (t.get(c.aSlot) ?? 0) + 0.5);
			t.set(c.bSlot, (t.get(c.bSlot) ?? 0) + 0.5);
		}
	}
	return t;
};
describe("parsePair / parseSkeptic", () => {
	test("parsePair accepts A/B/tie and rejects the rest", () => {
		expect(parsePair('{"winner":"A","reason":"r"}')).toEqual({
			winner: "A",
			reason: "r",
		});
		expect(parsePair('{"winner":"b","reason":"x"}')?.winner).toBe("B");
		expect(parsePair('{"winner":"tie"}')?.winner).toBe("tie");
		expect(parsePair('{"winner":"banana"}')).toBeNull();
		expect(parsePair("no json here")).toBeNull();
	});
	test("parseSkeptic requires boolean comply", () => {
		expect(parseSkeptic('{"comply":true,"violations":["v"]}')).toEqual({
			comply: true,
			violations: ["v"],
		});
		expect(parseSkeptic('{"comply":false}')?.violations).toEqual([]);
		expect(parseSkeptic('{"comply":"yes"}')).toBeNull();
		expect(parseSkeptic("{")).toBeNull();
	});
	test("prompts embed task and answers blind", () => {
		const p = pairPrompt("Do X and Y", "answer one", "answer two");
		expect(p).toContain("Do X and Y");
		expect(p).toContain("answer one");
		expect(p).toContain("answer two");
		expect(p).not.toContain("a1");
		expect(skepticPrompt("Do X", "answer one")).toContain("CANDIDATE RESPONSE");
	});
});
describe("runTournament", () => {
	test("ranking follows the tally recomputed from comparisons", async () => {
		const r = await runTournament(
			"task",
			ATTEMPTS,
			scripted([
				'{"winner":"A"}',
				'{"winner":"B"}',
				'{"winner":"A"}',
				'{"comply":true}',
			]),
			"seed-1",
		);
		expect(r.comparisons).toHaveLength(3);
		expect(r.judgeCalls).toBe(4);
		const t = tallyOf(r);
		for (const [id, n] of t) expect(t.get(id)).toBe(n);
		const heads = [...t.entries()].sort(
			(x, y) => y[1] - x[1] || x[0].localeCompare(y[0]),
		);
		expect(r.ranking[0]).toBe(heads[0]?.[0]);
		expect(r.skeptic).toHaveLength(1);
	});
	test("ties rank by id; skeptic walks the ranking and vetoes", async () => {
		const r = await runTournament(
			"task",
			ATTEMPTS,
			scripted([
				'{"winner":"tie"}',
				'{"winner":"tie"}',
				'{"winner":"tie"}',
				'{"comply":false,"violations":["missing Y"]}',
				'{"comply":true}',
			]),
			"seed-2",
		);
		expect(r.ranking).toEqual(["a1", "a2", "a3"]);
		expect(r.winner).toBe("a2");
		expect(r.skeptic.map((s) => s.attempt)).toEqual(["a1", "a2"]);
		expect(r.skeptic[0]?.comply).toBe(false);
		expect(r.judgeCalls).toBe(5);
	});
	test("all attempts vetoed = honest null winner", async () => {
		const r = await runTournament(
			"task",
			ATTEMPTS,
			scripted([
				'{"winner":"tie"}',
				'{"winner":"tie"}',
				'{"winner":"tie"}',
				'{"comply":false}',
				'{"comply":false}',
				'{"comply":false}',
			]),
			"seed-3",
		);
		expect(r.winner).toBeNull();
		expect(r.skeptic).toHaveLength(3);
	});
	test("unparseable judge output = tie with error, honest null winner", async () => {
		const r = await runTournament(
			"task",
			ATTEMPTS,
			scripted([
				"banana",
				"banana",
				"banana",
				"garbage",
				'{"comply":false}',
				'{"comply":false}',
			]),
			"seed-4",
		);
		expect(r.comparisons.every((c) => c.winner === "tie" && c.error)).toBe(
			true,
		);
		expect(r.winner).toBeNull();
		expect(r.judgeCalls).toBe(6);
	});
	test("empty attempts = degenerate result", async () => {
		const r = await runTournament("task", [], scripted([]), "seed-5");
		expect(r.winner).toBeNull();
		expect(r.ranking).toEqual([]);
		expect(r.judgeCalls).toBe(0);
	});
});
