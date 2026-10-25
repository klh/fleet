// ext.test.ts — tests for the external known-set slice harness (W823):
// normalization/EM, judge verdict parsing, DSV parsing, seeded slicing,
// seal/verify roundtrip (incl. tamper), scoring, injected-call judge pass.
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emCheck,
	judgeRunExt,
	lastAnswerLine,
	mergeJudge,
	normalizeExt,
	normNumberExt,
	parseExtVerdict,
	scoreSlice,
} from "./ext-score.ts";
import { parseDsv, extPool, extSlice } from "./ext-seal.ts";
import { sha } from "./core.ts";

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const FIX = [
	["", "Prompt", "Answer", "reasoning_types"].join(TAB),
	["0", "What is 2+2? ", "4", "Numerical reasoning"].join(TAB),
	["1", '"He said ""hello"""', "hello", "Multiple constraints"].join(TAB),
	["2", `"multi${NL}line ""q"""`, "two words", "Temporal reasoning"].join(TAB),
].join(NL);

import { extSealFrom, verifyExt } from "./ext-seal.ts";

test.describe("ext seal", () => {
	test("parseDsv: quoting, doubled quotes, embedded newline @unit", () => {
		const rows = parseDsv(FIX);
		expect(rows.length).toBe(4);
		expect(rows[1]?.[1]).toBe("What is 2+2? ");
		expect(rows[2]?.[1]).toBe('He said "hello"');
		const want = ["multi", 'line "q"'].join(NL);
		expect(rows[3]?.[1]).toBe(want);
	});
	test("extPool maps Prompt/Answer/reasoning; trims @unit", () => {
		const pool = extPool(FIX);
		expect(pool.length).toBe(3);
		expect(pool[0]?.id).toBe("fr1");
		expect(pool[0]?.prompt).toBe("What is 2+2?");
		expect(pool[2]?.reasoning).toBe("Temporal reasoning");
	});
	test("extSlice is deterministic and obeys the first-k rule @unit", () => {
		const pool = extPool(FIX);
		const a = extSlice(pool, 2);
		const b = extSlice(pool, 2);
		expect(a).toEqual(b);
		const full = extSlice(pool, 3);
		expect(extSlice(pool, 2)).toEqual(full.slice(0, 2));
	});
});

test.describe("ext score", () => {
	test("scoreSlice: em hit, miss, missing @unit", () => {
		const tasks = [
			{ id: "fr1", prompt: "q", answer: "4", reasoning: "n", links: 0 },
			{
				id: "fr2",
				prompt: "q",
				answer: "Jane Ballou",
				reasoning: "m",
				links: 0,
			},
		];
		const answers = new Map([
			["fr1", "ANSWER: 4"],
			["fr2", "something else entirely"],
		]);
		const rows = scoreSlice(tasks, answers);
		expect(rows[0]?.em).toBe(true);
		expect(rows[1]?.em).toBe(false);
		const missing = scoreSlice(tasks, new Map());
		expect(missing[0]?.em).toBeNull();
	});
});

const quiet = () => {};
test.describe("ext seal roundtrip", () => {
	test("seal → verify PASS → tamper FAIL; frames.json deterministic @unit", () => {
		const dir = mkdtempSync(join(tmpdir(), "arena-ext-"));
		const raw = join(dir, "raw.tsv");
		writeFileSync(raw, FIX);
		try {
			extSealFrom(raw, dir, quiet);
			expect(verifyExt(dir, raw).ok).toBe(true);
			const body1 = readFileSync(join(dir, "frames.json"), "utf8");
			const dir2 = mkdtempSync(join(tmpdir(), "arena-extb-"));
			writeFileSync(join(dir2, "raw.tsv"), FIX);
			extSealFrom(join(dir2, "raw.tsv"), dir2, quiet);
			const body2 = readFileSync(join(dir2, "frames.json"), "utf8");
			expect(sha(body2)).toBe(sha(body1));
			writeFileSync(join(dir, "frames.json"), `${body1}x`);
			expect(verifyExt(dir, raw).ok).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(join(tmpdir(), "arena-extb-"), { recursive: true, force: true });
		}
	});
});

test.describe("ext judge", () => {
	const jt = [
		{ id: "fr1", prompt: "q1", answer: "4", reasoning: "n", links: 0 },
		{ id: "fr2", prompt: "q2", answer: "5", reasoning: "m", links: 0 },
	];
	const call = async (p: string) => {
		void p;
		return '{"score": 1, "verdict": "correct", "reason": "ok"}';
	};
	test("judgeRunExt: injected verdicts; second pass resumes @unit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "arena-extj-"));
		const f = join(dir, "answers.jsonl");
		const answers = [
			JSON.stringify({ type: "answer", id: "fr1", answer: "4" }),
			JSON.stringify({ type: "answer", id: "fr2", answer: "wrong" }),
		].join(NL);
		writeFileSync(f, `${answers}${NL}`);
		try {
			const s1 = await judgeRunExt({ file: f, tasks: jt, call });
			expect(s1.judged).toBe(2);
			const s2 = await judgeRunExt({ file: f, tasks: jt, call });
			expect(s2.resumed).toBe(2);
			const amap = new Map([
				["fr1", "4"],
				["fr2", "wrong"],
			]);
			const rows = await mergeJudge(scoreSlice(jt, amap), f);
			expect(rows[0]?.judge_score).toBe(1);
			expect(rows[1]?.judge_score).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test.describe("ext em", () => {
	test("normalize: punctuation, articles, whitespace, numbers @unit", () => {
		expect(normalizeExt("The  Jane  Ballou!")).toBe("jane ballou");
		expect(normalizeExt("a Plan, the Execution")).toBe("plan execution");
		expect(normNumberExt("$189,777.00")).toBe(189777);
		expect(normNumberExt("2.0")).toBe(2);
		expect(normNumberExt("46%")).toBe(46);
	});
	test("emCheck: last line, prefix strip, number forms @unit", () => {
		expect(emCheck("Jane Ballou", "ANSWER: Jane Ballou")).toBe(true);
		expect(emCheck("2", "Final answer: 2.")).toBe(true);
		expect(emCheck("Paris", "The answer is: Paris, France.")).toBe(false);
		const got = ["step one", "Final Answer: 46"].join(NL);
		expect(lastAnswerLine(got)).toBe("46");
	});
	test("parseExtVerdict: format-checked, consistent @unit", () => {
		const good = '{"score": 1, "verdict": "correct", "reason": "r"}';
		expect(parseExtVerdict(good)?.score).toBe(1);
		expect(parseExtVerdict("not json")).toBeNull();
		const mixed = '{"score": 1, "verdict": "incorrect", "reason": "x"}';
		expect(parseExtVerdict(mixed)).toBeNull();
	});
});
