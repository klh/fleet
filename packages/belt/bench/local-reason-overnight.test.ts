// local-reason-overnight.test.ts — unit coverage for the W532 sealed rig.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Leg, Out } from "./arena/legs.ts";
import {
	classify,
	doneSet,
	extractBlocks,
	gradeCode,
	median,
	type RoundRow,
	roundPlan,
	summarize,
} from "./local-reason-overnight.ts";

const fakeOut = (over: Record<string, unknown>): Out =>
	({ ok: true, finish: "stop", text: "x", ...over }) as unknown as Out;

const mkRow = (over: Record<string, unknown>): RoundRow =>
	({
		type: "round",
		leg: "a",
		round: 1,
		task: "code",
		phase: "warm",
		pass: true,
		fail_kind: null,
		...over,
	}) as unknown as RoundRow;

describe("extractBlocks", () => {
	test("returns both bodies, tolerating prose", () => {
		const two = "```ts\nconst a = 1;\n```\n```ts\nconst b = 2;\n```";
		expect(extractBlocks(two)).toEqual(["const a = 1;", "const b = 2;"]);
		const prose = `Prose.\n\n\`\`\`ts\nA\n\`\`\`\nmid\n\n\`\`\`ts\nB\n\`\`\``;
		expect(extractBlocks(prose)).toEqual(["A", "B"]);
	});
	test("needs two blocks", () => {
		expect(extractBlocks("```ts\nonly\n```")).toBeNull();
		expect(extractBlocks("no fences at all")).toBeNull();
	});
});

describe("classify", () => {
	const verdict = (
		over: Record<string, unknown>,
		expected: string | null,
		grade: { ok: boolean; tail: string } | null = null,
	) => classify(fakeOut({ served: "m", ...over }), expected, grade);
	test("transport fail voids the round", () => {
		const v = verdict({ ok: false, err: "conn refused" }, "m");
		expect(v.failKind).toBe("transport");
		expect(v.pass).toBe(false);
	});
	test("served-model mismatch is an identity void", () => {
		const v = verdict({ served: "wrong-model" }, "m");
		expect(v.failKind).toBe("identity");
		expect(v.identity).toBe(true);
		expect(v.pass).toBe(false);
	});
	test("length finish is truncated", () => {
		expect(verdict({ finish: "length" }, "m").failKind).toBe("truncated");
	});
	test("stop with empty text is empty", () => {
		expect(verdict({ text: "" }, "m").failKind).toBe("empty");
	});
	test("failing grade is tests", () => {
		expect(verdict({}, "m", { ok: false, tail: "x" }).failKind).toBe("tests");
	});
	test("clean round passes", () => {
		const v = verdict({}, "m", { ok: true, tail: "" });
		expect(v.pass).toBe(true);
		expect(v.failKind).toBeNull();
	});
	test("null expected never mismatches", () => {
		const v = verdict({ served: undefined }, null);
		expect(v.identity).toBe(false);
		expect(v.pass).toBe(true);
	});
});

describe("gradeCode", () => {
	test("golden path passes a correct impl, fails a broken one", () => {
		const fence = (body: string) => `\`\`\`ts\n${body}\n\`\`\``;
		const impl = `export function parseDuration(s: string): number | null {
	const re = /(\\d+(?:\\.\\d+)?)\\s*([dhms])/gi;
	let total = 0;
	let seen = false;
	for (const m of s.matchAll(re)) {
		seen = true;
		const v = Number(m[1] ?? 0);
		const u = (m[2] ?? "").toLowerCase();
		total += v * (u === "d" ? 86400 : u === "h" ? 3600 : u === "m" ? 60 : 1);
	}
	if (!seen) return null;
	return s.replace(re, "").trim().length === 0 ? total : null;
}
`;
		const tests = `import { describe, expect, test } from "bun:test";
import { parseDuration } from "./impl.ts";
describe("parseDuration", () => {
	test("1h30m is 5400", () => expect(parseDuration("1h30m")).toBe(5400));
	test("45s", () => expect(parseDuration("45s")).toBe(45));
	test("garbage is null", () => expect(parseDuration("2x")).toBeNull());
});
`;
		const run = `w532-test-${Date.now()}`;
		expect(gradeCode(`${fence(impl)}\n${fence(tests)}`, run, "g").ok).toBe(
			true,
		);
		const badImpl =
			"export function parseDuration(s: string): number | null {\n\treturn 42;\n}\n";
		expect(gradeCode(`${fence(badImpl)}\n${fence(tests)}`, run, "b").ok).toBe(
			false,
		);
		rmSync(join("/tmp", "w532-bench", run), { recursive: true, force: true });
	}, 300_000);
});

describe("roundPlan", () => {
	test("deterministic per seed; orders are permutations; tasks once", () => {
		const legs = [{ id: "a" }, { id: "b" }, { id: "c" }] as unknown as Leg[];
		const tasks: ("code" | "review")[] = ["code", "review"];
		const one = roundPlan("seed-a", 1, tasks, legs);
		expect(roundPlan("seed-a", 1, tasks, legs)).toEqual(one);
		const firsts = (plan: typeof one) =>
			plan
				.map((p) => p.order[0]?.id ?? "")
				.sort()
				.join(",");
		expect(firsts(one)).not.toBe(firsts(roundPlan("seed-b", 1, tasks, legs)));
		for (const p of one)
			expect([...p.order].map((l) => l.id).sort()).toEqual(["a", "b", "c"]);
		expect(one.map((p) => p.task).sort()).toEqual(["code", "review"]);
	});
});

test("median: odd, even, empty", () => {
	expect(median([5, 1, 9])).toBe(5);
	expect(median([1, 9])).toBe(5);
	expect(median([3])).toBe(3);
	expect(median([])).toBeNull();
});

describe("summarize", () => {
	test("mines per-leg stats over warm rows only", () => {
		const dir = mkdtempSync(join(tmpdir(), "w532-sum-"));
		const file = join(dir, "run.jsonl");
		const lines = [
			mkRow({ phase: "warmup", round: 0, wall_ms: 9999, cost_usd: 0.5 }),
			mkRow({ wall_ms: 100, out_tok: 200, reason_tok: 50, cost_usd: 0.1 }),
			mkRow({
				pass: false,
				fail_kind: "truncated",
				wall_ms: 300,
				cost_usd: 0.2,
			}),
			mkRow({ leg: "b", wall_ms: 200, out_tok: 100, cost_usd: 0.3 }),
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		const s = summarize(file, ["a", "b"]);
		rmSync(dir, { recursive: true, force: true });
		expect(s).toHaveLength(2);
		const a = s[0];
		const b = s[1];
		expect(a?.attempted).toBe(2); // warmup excluded from the denominator
		expect(a?.pass).toBe(1);
		expect(a?.by_kind).toEqual({ truncated: 1 });
		expect(a?.wall_p50_warm).toBe(200);
		expect(a?.toks_p50_warm).toBe(2000);
		expect(a?.reason_share_p50_warm).toBeCloseTo(0.25);
		expect(a?.cost_usd_total).toBeCloseTo(0.8);
		expect(b?.attempted).toBe(1);
		expect(b?.pass).toBe(1);
		expect(b?.by_kind).toEqual({});
		expect(b?.wall_p50_warm).toBe(200);
		expect(b?.toks_p50_warm).toBe(500);
		expect(b?.reason_share_p50_warm).toBeNull();
		expect(b?.cost_usd_total).toBeCloseTo(0.3);
	});
});

describe("doneSet", () => {
	test("collects exactly the round keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "w532-done-"));
		const file = join(dir, "run.jsonl");
		const lines = [
			JSON.stringify({ type: "seal", at: "t" }),
			JSON.stringify(mkRow({ leg: "a", round: 1, task: "code" })),
			JSON.stringify(mkRow({ leg: "b", round: 2, task: "review" })),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);
		const done = doneSet(file);
		rmSync(dir, { recursive: true, force: true });
		expect([...done].sort()).toEqual(["a|1|code", "b|2|review"]);
	});
});
