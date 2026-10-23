// bench/w1143/run.test.ts — pure-logic tests for the runner: no tier calls,
// no filesystem gates (parseArgs / attemptPrompt / rowOf / summarize).
import { describe, expect, test } from "bun:test";
import {
	type ArmName,
	attemptPrompt,
	type ModelReply,
	parseArgs,
	rowOf,
	summarize,
	type TaskOutcome,
} from "./run.ts";

const reply = (over: Partial<ModelReply> = {}): ModelReply => ({
	ok: true,
	status: 200,
	text: "ans",
	wall: 100,
	inTok: 10,
	outTok: 20,
	tokEst: false,
	...over,
});
const scored = { score: 1, pass: true };

describe("parseArgs", () => {
	test("defaults; absent numeric flags fall back (Number(null)=0 guard)", () => {
		expect(parseArgs([])).toEqual({ classes: ["b", "e"], n: 12, lanes: 3 });
		expect(parseArgs(["--n", "0"])).toMatchObject({ n: 12 });
		expect(parseArgs(["--lanes", "99"])).toMatchObject({ lanes: 8 });
		expect(parseArgs(["--n", "500"])).toMatchObject({ n: 130 });
	});
	test("invalid classes filter back to defaults", () => {
		expect(parseArgs(["--classes", "x,z"])).toMatchObject({
			classes: ["b", "e"],
		});
		expect(parseArgs(["--classes", "e"])).toMatchObject({ classes: ["e"] });
	});
});
describe("attemptPrompt", () => {
	test("b rides the code-gen prompt; e wraps the sealed decision text", () => {
		expect(attemptPrompt("b", "code task", "ignored")).toBe("code task");
		expect(attemptPrompt("e", undefined, "Pick a")).toContain("Pick a");
		expect(attemptPrompt("e", undefined, "Pick a")).toContain("Request:");
	});
});
describe("rowOf", () => {
	test("maps reply + score into the NDJSON row", () => {
		const r = rowOf(
			"strong" as ArmName,
			"s1",
			"e",
			"t1",
			8903,
			0,
			reply({ wall: 111, outTok: 33 }),
			scored,
		);
		expect(r.arm).toBe("strong");
		expect(r.attempt).toBe("s1");
		expect(r.wall).toBe(111);
		expect(r.outTok).toBe(33);
		expect(r.score).toBe(1);
		expect(r.pass).toBe(true);
		expect(r.detail).toBeUndefined();
	});
	test("a failed call carries the transport error, no verdict", () => {
		const r = rowOf(
			"race",
			"r2",
			"e",
			"t1",
			8902,
			0.7,
			reply({ ok: false, status: 500, text: "", err: "HTTP 500" }),
			null,
		);
		expect(r.ok).toBe(false);
		expect(r.score).toBeNull();
		expect(r.pass).toBeNull();
		expect(r.detail).toBe("HTTP 500");
	});
});
describe("summarize", () => {
	const outcome = (cls: "b" | "e"): TaskOutcome => ({
		cls,
		task: `t-${cls}`,
		strong: rowOf("strong", "s1", cls, "t", 8903, 0, reply(), {
			score: 1,
			pass: true,
		}),
		cheap: rowOf(
			"cheap",
			"c1",
			cls,
			"t",
			8902,
			0,
			reply({ wall: 200, outTok: 10 }),
			{
				score: 0.5,
				pass: false,
			},
		),
		race: {
			attempts: [
				rowOf("race", "r1", cls, "t", 8902, 0.7, reply({ wall: 100 }), {
					score: 0,
					pass: false,
				}),
				rowOf("race", "r2", cls, "t", 8902, 0.7, reply({ wall: 300 }), {
					score: 0.5,
					pass: true,
				}),
			],
			tournament: null,
			winner: "r2",
			winnerScore: 0.5,
			winnerPass: false,
			oracle: "r3",
			oracleScore: 1,
			judgeTok: { inTok: 0, outTok: 40, wall: 50 },
			serial: 2,
		},
	});
	test("aggregates per arm × class with honest race wall + judge cost", () => {
		const rows = summarize([outcome("e")]);
		const e = (arm: string) => rows.find((r) => r.arm === arm && r.cls === "e");
		expect(e("strong")).toMatchObject({
			n: 1,
			passes: 1,
			meanWall: 100,
			outTok: 20,
			judgeOutTok: 0,
			meanSerial: 1,
		});
		expect(e("cheap")).toMatchObject({ passes: 0, meanWall: 200, outTok: 10 });
		expect(e("race")).toMatchObject({
			passes: 0,
			meanWall: 350,
			outTok: 80,
			judgeOutTok: 40,
			meanSerial: 2,
		});
	});
	test("empty input yields zeroed rows for both classes", () => {
		const rows = summarize([]);
		expect(rows).toHaveLength(6);
		expect(rows.every((r) => r.n === 0 && r.passes === 0)).toBe(true);
	});
});
