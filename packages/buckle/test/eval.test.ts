// test/eval.test.ts — the W424 eval harness: computed keys (self-acceptance
// over the full generated sweep), determinism (paired diffs need identical
// task lists), code-snippet vm verification, stats + verdict rules.
import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { danishNumber } from "../src/eval/danish.ts";
import {
	canon,
	jsonEq,
	norm,
	numFrom,
	stripFences,
} from "../src/eval/graders.ts";
import { majority } from "../src/eval/report.ts";
import { ping, runArm } from "../src/eval/runner.ts";
import {
	type ArmShape,
	binomTwoSidedP,
	decideShape,
	type ShapeStats,
	shapeStats,
	wilson,
} from "../src/eval/stats.ts";
import { makeTasks } from "../src/eval/tasks.ts";
import { makeCodeTasks } from "../src/eval/tasks-code.ts";
import { type Arm, SHAPES, type TaskResult } from "../src/eval/types.ts";

describe("graders", () => {
	test("stripFences + norm", () => {
		expect(stripFences("```txt\n42\n```")).toBe("42");
		expect(stripFences("42")).toBe("42");
		expect(norm("  The ANSWER. ")).toBe("the answer");
		expect(norm('"open"')).toBe("open");
		expect(norm("a\tb")).toBe("a b");
	});

	test("numFrom + canon + jsonEq", () => {
		expect(numFrom("The answer is 1,024 tokens.")).toBe(1024);
		expect(numFrom("no digits")).toBeUndefined();
		expect(canon([1, 2])).toBe("[1,2]");
		expect(jsonEq({ a: 1 }, { a: 1 })).toBe(true);
		expect(jsonEq([1, 2], [2, 1])).toBe(false);
	});
});

describe("danish number words", () => {
	test("anchor table", () => {
		expect(danishNumber(0)).toBe("nul");
		expect(danishNumber(1)).toBe("en");
		expect(danishNumber(2)).toBe("to");
		expect(danishNumber(7)).toBe("syv");
		expect(danishNumber(10)).toBe("ti");
		expect(danishNumber(11)).toBe("elleve");
		expect(danishNumber(13)).toBe("tretten");
		expect(danishNumber(20)).toBe("tyve");
		expect(danishNumber(21)).toBe("enogtyve");
	});
});

describe("danish number words — twenties", () => {
	test("tens + compounds", () => {
		expect(danishNumber(30)).toBe("tredive");
		expect(danishNumber(43)).toBe("treogfyrre");
		expect(danishNumber(50)).toBe("halvtreds");
	});
});

describe("danish number words — twenties", () => {
	test("more compounds", () => {
		expect(danishNumber(53)).toBe("treoghalvtreds");
		expect(danishNumber(65)).toBe("femogtres");
		expect(danishNumber(70)).toBe("halvfjerds");
		expect(danishNumber(71)).toBe("enoghalvfjerds");
		expect(danishNumber(80)).toBe("firs");
		expect(danishNumber(90)).toBe("halvfems");
		expect(danishNumber(99)).toBe("nioghalvfems");
	});
});

describe("task generators", () => {
	test("determinism + key self-acceptance sweep", () => {
		for (const shape of SHAPES) {
			const t1 = makeTasks(shape, 40, 424);
			const t2 = makeTasks(shape, 40, 424);
			expect(t1.map((t) => t.key).join("|")).toBe(
				t2.map((t) => t.key).join("|"),
			);
			for (const t of t1) {
				expect(t.check(t.key)).toBe(true);
			}
		}
	});

	test("coverage: n honored, families spread", () => {
		const tasks = makeTasks("danish", 130, 424);
		expect(tasks.length).toBe(130);
		const fams = new Set(tasks.map((t) => t.meta.family));
		expect(fams.size).toBeGreaterThanOrEqual(5);
	});
});

describe("code tasks — vm verification", () => {
	test("snippet output equals computed key", () => {
		const tasks = makeCodeTasks(60, 424);
		for (const t of tasks) {
			const code = t.meta.code;
			expect(typeof code).toBe("string");
			const value = runInNewContext(String(code));
			expect(canon(value)).toBe(t.key);
		}
	});
});

describe("stats", () => {
	test("wilson bounds are sane", () => {
		expect(wilson(0, 0)).toEqual([0, 1]);
		const [lo, hi] = wilson(104, 130);
		expect(lo).toBeLessThan(0.8);
		expect(hi).toBeGreaterThan(0.8);
		const w = wilson(13, 130);
		expect(w[0]).toBeGreaterThan(0.05);
		expect(w[1]).toBeLessThan(0.2);
	});

	test("exact McNemar p (two-sided binomial)", () => {
		expect(binomTwoSidedP(0, 0)).toBe(1);
		expect(binomTwoSidedP(5, 10)).toBe(1);
		const p = binomTwoSidedP(2, 12);
		expect(p).toBeLessThan(0.05);
	});
});

// verdict-rule fixtures (top-level: each chunk must parse standalone)
const vArm = (ok: number): ArmShape => ({
	ok,
	n: 130,
	latency_p50_ms: 0,
	tokens_in: 0,
	tokens_out: 0,
});

const vBools = (k: number): boolean[] =>
	Array.from({ length: 130 }, (_, i) => i < k);

const vStats = (aok: number, bok: number): ShapeStats =>
	shapeStats(
		"code",
		vArm(aok),
		vArm(bok),
		vBools(aok).map((a, i) => ({ a, b: vBools(bok)[i] ?? false })),
	);

describe("verdict rules", () => {
	test("separated intervals → quality winner", () => {
		const v = decideShape(vStats(130, 100));
		expect(v.verdict).toBe("a");
		expect(v.decided_by).toBe("quality");
	});

	test("interval overlap → abstain without prices", () => {
		const v = decideShape(vStats(110, 108));
		expect(v.verdict).toBe("abstain");
		expect(v.decided_by).toBe("none");
	});
});

describe("verdict rules — cost tiebreak", () => {
	test("tie + prices → cheaper per resolved decides", () => {
		const s = vStats(110, 108);
		const v = decideShape(s, { a: 0.002, b: 0.001 });
		expect(v.verdict).toBe("b");
		expect(v.decided_by).toBe("cost");
		const v2 = decideShape(s, { a: 0.001, b: 0.002 });
		expect(v2.verdict).toBe("a");
	});
});

describe("majority across repeats", () => {
	test("tie → incorrect (strict)", () => {
		const row = (ok: boolean, i: number): TaskResult => ({
			task_id: `t-${String(i)}`,
			shape: "code",
			arm: "a",
			repeat: 0,
			ok,
			latency_ms: 1,
			tokens_in: 0,
			tokens_out: 0,
			answer: "",
		});
		const rows = [row(true, 0), row(false, 0)];
		const ids = ["t-0"];
		expect(majority(rows, ids, 2)).toEqual([false]);
		expect(majority(rows, ids, 1)).toEqual([true]);
	});
});

describe("runner against a mock arm", () => {
	test("runArm grades + ping detects liveness", async () => {
		const srv = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					choices: [{ message: { content: "42" } }],
					usage: { prompt_tokens: 5, completion_tokens: 1 },
				}),
		});
		const arm: Arm = {
			name: "a",
			url: `http://127.0.0.1:${String(srv.port)}/v1`,
			model: "mock",
		};
		const tasks = makeTasks("menial", 3, 424);
		const rows = await runArm(arm, tasks, {
			concurrency: 2,
			timeout_ms: 5000,
			max_tokens: 100,
			repeats: 1,
		});
		expect(rows.length).toBe(3);
		expect(typeof rows[0]?.ok).toBe("boolean");
		expect(await ping(arm)).toBe(true);
		srv.stop(true);
		expect(await ping(arm)).toBe(false);
	});
});
