import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capMiddle,
	judgeRun,
	judgeTaskPrompt,
	parseVerdict,
} from "./judge.ts";
import { loadRun } from "./report.ts";
import { variantReport } from "./report-variant.ts";
import { loadTasks } from "./seal.ts";
import {
	appendManifestRow,
	manifestRow,
	type VariantSpec,
} from "./variant.ts";

const dir = mkdtempSync(join(tmpdir(), "arena-judge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ids = loadTasks("a").tasks.slice(0, 3).map((t) => t.id);
const eid = loadTasks("e").tasks[0]?.id ?? "e-000";

const glm = (t: string, ver: string): VariantSpec => ({
	transform: t,
	transformVersion: ver,
	models: "glm",
	legs: ["pure-api", "stack-engine-zai"],
});

const taskRow = (
	run: string,
	v: VariantSpec,
	i: number,
	leg: string,
) => ({
	type: "row",
	run,
	cls: "a",
	task: ids[i],
	leg,
	phase: "cold",
	ok: true,
	wall_ms: 1000 + i,
	ttft_ms: 10,
	ttfc_ms: 12,
	in_tok: 100,
	out_tok: 50,
	cached_tok: 0,
	tok_est: false,
	streamed: true,
	finish: "stop",
	cost_usd: 0.001,
	priced: "glm-5.3-flash",
	score: 1,
	conf: null,
	load1: 1,
	answer: "A sufficient answer.",
	chars_in: 400,
	chars_out: 400,
	transform: v.transform,
});

function synth(run: string, v: VariantSpec) {
	const m = manifestRow(run, v, {
		classes: ["a"],
		n: 3,
		sealed: "6253f5092545542e",
		cacheHash: "n/a",
		promptsHash: { a: "x" },
		started: "2026-10-03T00:00:00Z",
	});
	appendManifestRow(dir, m);
	const file = join(dir, `${run}.jsonl`);
	const put = (x: unknown) => appendFileSync(file, `${JSON.stringify(x)}\n`);
	put({
		...m,
		type: "meta",
		host: "h",
		bun: "1",
		manifest: "6253f5092545542e",
		price_src: "test",
		dropped: [],
	});
	for (let i = 0; i < 3; i++)
		for (const leg of v.legs) put(taskRow(run, v, i, leg));
	put({ type: "end", run, ended: "2026-10-03T01:00:00Z" });
}
synth("20261003T000000Z-base", glm("none", "none/1"));
synth("20261003T010000Z-cand", glm("condense", "ref-condense/1"));

const good = JSON.stringify({ score: 0.9, verdict: "good", reason: "fulfils" });
const quiet = () => {};

describe("judge units", () => {
	test("parseVerdict accepts clean, wrapped and embedded JSON; rejects junk", () => {
		expect(
			parseVerdict('{"score":0.9,"verdict":"good","reason":"r"}')?.score,
		).toBe(0.9);
		expect(
			parseVerdict(
				'<think>hm</think>{"score":0.5,"verdict":"mixed","reason":"r"}',
			)?.verdict,
		).toBe("mixed");
		expect(
			parseVerdict('Sure: {"score":0.25,"verdict":"poor","reason":"r"} done')
				?.score,
		).toBe(0.25);
		expect(parseVerdict('{"score":1.5,"verdict":"good","reason":"r"}')).toBeNull();
		expect(parseVerdict("no json here")).toBeNull();
	});
	test("capMiddle bounds the result inside max", () => {
		expect(capMiddle("abcdef", 10)).toBe("abcdef");
		const c = capMiddle("x".repeat(100), 20);
		expect(c.length).toBeLessThanOrEqual(20);
		expect(c).toContain("middle elided");
	});
	test("judgeTaskPrompt rebuilds the sealed prompt, ref stripped", () => {
		const p = judgeTaskPrompt(
			"20261003T000000Z-base",
			"a",
			ids[0] ?? "a-000",
			"pure-api",
			"cold",
			16000,
		);
		expect(p).not.toMatch(/^\[ref:/);
		expect(p.length).toBeGreaterThan(20);
		const e = judgeTaskPrompt(
			"20261003T000000Z-base",
			"e",
			eid,
			"pure-api",
			"cold",
			16000,
		);
		expect(e).toContain("TIER:");
		const raw = judgeTaskPrompt(
			"20261003T000000Z-base",
			"e",
			eid,
			"stack-router",
			"cold",
			16000,
		);
		expect(raw).not.toContain("TIER:");
	});
});

describe("judgeRun", () => {
	test("grades all rows, loadRun attaches, resume skips", async () => {
		const seen: string[] = [];
		const s1 = await judgeRun({
			runId: "20261003T000000Z-base",
			resDir: dir,
			call: async (p) => {
				seen.push(p);
				return good;
			},
			log: quiet,
		});
		expect(s1.judged).toBe(6);
		expect(seen.length).toBe(6);
		expect(seen[0]).toContain("quality judge");
		expect(seen[0]).toContain("RESPONSE:");
		expect(seen[0]).toContain("A sufficient answer.");
		expect(s1.judged).toBe(6);
		expect(s1.failed).toBe(0);
		const r = await loadRun("20261003T000000Z-base", dir);
		expect(r.rows.every((x) => x.judge === 0.9)).toBe(true);
		expect(r.rows.every((x) => x.judgeVerdict === "good")).toBe(true);
		const s2 = await judgeRun({
			runId: "20261003T000000Z-base",
			resDir: dir,
			call: async () => {
				throw new Error("must not be called");
			},
			log: quiet,
		});
		expect(s2.judged).toBe(0);
		expect(s2.resumed).toBe(6);
	});
	test("failures land as judge_error rows and retry on the next pass", async () => {
		const s3 = await judgeRun({
			runId: "20261003T010000Z-cand",
			resDir: dir,
			call: async () => {
				throw new Error("tier down");
			},
			log: quiet,
		});
		expect(s3.failed).toBe(6);
		const s4 = await judgeRun({
			runId: "20261003T010000Z-cand",
			resDir: dir,
			call: async () => good,
			log: quiet,
		});
		expect(s4.judged).toBe(6);
		const r = await loadRun("20261003T010000Z-cand", dir);
		expect(r.rows.every((x) => x.judge === 0.9)).toBe(true);
	});
	test("variant report renders the judge columns", async () => {
		const md = await variantReport({ resDir: dir });
		expect(md).toContain("Δjudge vs base [95% CI]");
		expect(md).toContain("0 (ref)");
	});
});
