// tests/review-eval.test.ts — W1172 harness unit + stubbed-e2e coverage.
// Zero real agent spawns and zero committed answer-key bytes: the e2e leg
// injects a fake spawner and an in-process judge serve over a synthetic
// corpus. Nothing here is evidence of review quality (W1144 law).
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TASKS,
	corpusSha,
	taskById,
	type ReviewTask,
} from "./review-eval/corpus.ts";
import {
	validateInventory,
	type Inventory,
	type InventoryIssue,
} from "./review-eval/inventory.ts";
import { buildJudgeContent, parseJudgeJson } from "./review-eval/judge.ts";
import {
	BENCH_CONTRACT,
	buildExecutorArgv,
	buildSystemPrompt,
	buildTaskPrompt,
	parseClaudeEnvelope,
} from "./review-eval/executor.ts";
import {
	DEFAULT_BEFORE_REV,
	resolveArm,
	SKILL_PATH,
	gateOpen,
	main,
	parseArgs,
	planState,
	runMode,
	selectTasks,
} from "./review-eval/run.ts";
import { sha256 } from "./review-eval/receipt.ts";

const synthTasks: ReviewTask[] = [
	{
		id: "s1",
		name: "syn-a.ts",
		ask: "Review the file below and report any issues.",
		content: "line one\n  const x = 1;\nline three",
	},
	{
		id: "s2",
		name: "syn-b.ts",
		ask: "Review the file below and report any issues.",
		content: "only line",
	},
];

const synthInv: Inventory = {
	tasks: {
		s1: [
			{
				id: "x1",
				issueClass: "correctness-generic",
				file: "syn-a.ts",
				line: 2,
				severity: "high",
			},
		],
		s2: [],
	},
};

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "w1172-test-"));
}

function writePin(dir: string, name: string, content: string): string {
	const p = join(dir, name);
	writeFileSync(p, content, { mode: 0o600 });
	return p;
}

afterEach(() => {
	for (const k of ["W1172_GATE", "W1172_JUDGE_KEY", "W1172_JUDGE_MODEL"]) {
		delete process.env[k];
	}
});

describe("w1172 corpus", () => {
	test("sha stable, ids unique, clean control present", () => {
		expect(corpusSha()).toBe(corpusSha());
		const ids = TASKS.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
		expect(taskById("t5")?.name).toBe("clean-util.ts");
	});
});

describe("w1172 inventory validation", () => {
	test("accepts the synthetic answer key", () => {
		expect(validateInventory(synthTasks, synthInv)).toEqual([]);
	});
	test("catches drift in every dimension", () => {
		const bad = (mutate: (inv: Inventory) => void): string[] => {
			const inv = structuredClone(synthInv);
			mutate(inv);
			return validateInventory(synthTasks, inv);
		};
		expect(
			bad((inv) => {
				delete inv.tasks.s2;
			}),
		).toContain("inventory missing task s2");
		const touch = (inv: Inventory): InventoryIssue => {
			const e = inv.tasks.s1?.[0];
			if (e === undefined) throw new Error("fixture lost");
			return e;
		};
		expect(
			bad((inv) => {
				touch(inv).issueClass = "made-up";
			}),
		).toContain("x1: unknown issueClass made-up");
		expect(
			bad((inv) => {
				touch(inv).file = "other.ts";
			}),
		).toContain("x1: file other.ts is not syn-a.ts");
		expect(
			bad((inv) => {
				touch(inv).line = 4;
			}),
		).toContain("x1: line 4 empty/absent");
	});
});

describe("w1172 args", () => {
	test("parseArgs defaults and flags", () => {
		const a = parseArgs([]);
		expect(a.mode).toBe("plan");
		expect(a.tasks).toEqual([]);
		const b = parseArgs(["--run", "--tasks", "t1,t5"]);
		expect(b.mode).toBe("run");
		expect(b.tasks).toEqual(["t1", "t5"]);
		expect(() => parseArgs(["--bogus"])).toThrow("unknown argument");
		expect(() => parseArgs(["--tasks"])).toThrow("missing value");
	});
	test("selectTasks filters and throws on unknown id", () => {
		expect(selectTasks(parseArgs(["--tasks", "t5"])).map((t) => t.id)).toEqual([
			"t5",
		]);
		expect(() => selectTasks(parseArgs(["--tasks", "t99"]))).toThrow(
			"unknown task id",
		);
	});
});

describe("w1172 parse legs", () => {
	test("parseClaudeEnvelope good, garbage, zero-usage", () => {
		const good = parseClaudeEnvelope(
			JSON.stringify({
				result: "r",
				usage: {
					input_tokens: 3,
					output_tokens: 4,
					cache_read_input_tokens: 5,
				},
				total_cost_usd: 0.01,
				is_error: false,
			}),
		);
		expect(good?.usage).toEqual({ input: 3, output: 4, cacheRead: 5 });
		expect(good?.costUsd).toBe(0.01);
		expect(good?.isError).toBe(false);
		expect(parseClaudeEnvelope("not json")).toBeNull();
		const zero = parseClaudeEnvelope(JSON.stringify({ result: "x" }));
		expect(zero?.usage).toEqual({ input: 0, output: 0, cacheRead: 0 });
		expect(zero?.costUsd).toBeNull();
	});
	test("parseJudgeJson extracts the balanced JSON object", () => {
		expect(
			parseJudgeJson('noise {"perIssue":[],"falsePositives":2} tail'),
		).toEqual({ perIssue: [], falsePositives: 2 });
		expect(parseJudgeJson("no braces")).toBeNull();
		expect(parseJudgeJson('{"a":1')).toBeNull();
	});
});

describe("w1172 prompt builders", () => {
	test("system prompt carries the skill and the bench contract", () => {
		const sys = buildSystemPrompt("SKILL TEXT");
		expect(sys).toContain("SKILL TEXT");
		expect(sys).toContain(BENCH_CONTRACT);
	});
	test("task prompt carries ask, name and file bytes", () => {
		const p = buildTaskPrompt(synthTasks[0] as ReviewTask);
		expect(p).toContain(synthTasks[0]?.ask ?? "");
		expect(p).toContain("syn-a.ts");
		expect(p).toContain("line three");
	});
	test("executor argv is the W960 claude-p recipe", () => {
		const argv = buildExecutorArgv({
			settingsPath: "/s.json",
			system: "SYS",
			prompt: "ASK",
		});
		expect(argv[0]).toBe("claude");
		expect(argv).toContain("-p");
		expect(argv).toContain("--output-format");
		expect(argv).toContain("json");
		expect(argv).toContain("--settings");
		expect(argv).toContain("/s.json");
		expect(argv).toContain("--append-system-prompt");
		expect(argv).toContain("SYS");
		expect(argv.at(-1)).toBe("ASK");
	});
	test("judge packet carries rubric, task, file and output", () => {
		const c = buildJudgeContent({
			url: "http://x",
			key: "k",
			model: "m",
			prompt: "RUBRIC-MARKER",
			ask: "THE-ASK",
			fileName: "f.ts",
			fileContent: "FILE-BYTES",
			reviewOutput: "REVIEW-TEXT",
		});
		expect(c).toContain("RUBRIC-MARKER");
		expect(c).toContain("THE-ASK");
		expect(c).toContain("f.ts");
		expect(c).toContain("FILE-BYTES");
		expect(c).toContain("REVIEW-TEXT");
	});
});

describe("w1172 arms and gate", () => {
	test("resolveArm pins rev, commit and content hash", () => {
		const bundle = resolveArm(DEFAULT_BEFORE_REV, SKILL_PATH);
		expect(bundle.arm.rev).toBe(DEFAULT_BEFORE_REV);
		expect(bundle.arm.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(bundle.arm.skillSha256).toBe(sha256(bundle.content));
		expect(bundle.content.length).toBeGreaterThan(0);
		expect(() => resolveArm("no-such-rev-w1172", SKILL_PATH)).toThrow();
	});
	test("gateOpen reads W1172_GATE strictly", () => {
		delete process.env.W1172_GATE;
		expect(gateOpen()).toBe(false);
		process.env.W1172_GATE = "open";
		expect(gateOpen()).toBe(true);
		process.env.W1172_GATE = "hold";
		expect(gateOpen()).toBe(false);
	});
	test("main --run refuses gate-shut: zero spawns, no out dir", async () => {
		const out = join(tmpDir(), "never-created");
		const code = await main(["--run", "--out", out]);
		expect(code).toBe(2);
		expect(existsSync(out)).toBe(false);
	});
	test("runMode refuses at the API level too", async () => {
		await expect(runMode(parseArgs(["--run"]))).rejects.toThrow("gate SHUT");
	});
});

describe("w1172 planState", () => {
	test("green on valid tmp pins", () => {
		const dir = tmpDir();
		process.env.W1172_JUDGE_KEY = "k";
		process.env.W1172_JUDGE_MODEL = "m";
		const state = planState(
			parseArgs([
				"--plan",
				"--inventory",
				writePin(dir, "inventory.json", JSON.stringify(synthInv)),
				"--judge-prompt",
				writePin(dir, "judge-prompt.md", "RUBRIC"),
				"--settings",
				writePin(dir, "settings.json", "{}"),
				"--before",
				DEFAULT_BEFORE_REV,
				"--after",
				"HEAD",
			]),
			synthTasks,
		);
		expect(state.ok).toBe(true);
		expect(state.problems).toEqual([]);
	});
	test("reports missing pins and missing judge env", () => {
		const state = planState(
			parseArgs([
				"--plan",
				"--inventory",
				"/nonexistent-w1172/i.json",
				"--judge-prompt",
				"/nonexistent-w1172/j.md",
				"--settings",
				"/nonexistent-w1172/s.json",
				"--before",
				DEFAULT_BEFORE_REV,
				"--after",
				"HEAD",
			]),
			synthTasks,
		);
		expect(state.ok).toBe(false);
		const joined = state.problems.join("\n");
		expect(joined).toContain("inventory missing");
		expect(joined).toContain("judge-prompt missing");
		expect(joined).toContain("executor-settings missing");
		expect(joined).toContain("W1172_JUDGE_KEY");
		expect(joined).toContain("W1172_JUDGE_MODEL");
	});
});

describe("w1172 stubbed e2e", () => {
	test("runMode builds the manifest, judges, writes a 0600 receipt", async () => {
		const dir = tmpDir();
		const invPath = writePin(dir, "inventory.json", JSON.stringify(synthInv));
		const jpPath = writePin(dir, "judge-prompt.md", "RUBRIC-BYTES");
		const stPath = writePin(dir, "settings.json", "{}");
		process.env.W1172_GATE = "open";
		process.env.W1172_JUDGE_KEY = "test-key";
		process.env.W1172_JUDGE_MODEL = "test-judge-model";
		let judgeAuth = "";
		let judgeModelSeen = "";
		let judgePacket = 0;
		const judge = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				judgeAuth = req.headers.get("authorization") ?? "";
				const body = (await req.json()) as {
					model?: string;
					messages?: { content?: string }[];
				};
				judgeModelSeen = body.model ?? "";
				judgePacket = body.messages?.[0]?.content?.length ?? 0;
				return Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									perIssue: [{ id: "x1", found: true }],
									falsePositives: 1,
									notes: "stub",
								}),
							},
						},
					],
					usage: { prompt_tokens: 12, completion_tokens: 8 },
				});
			},
		});
		expect(judge.port).toBeGreaterThan(0);
		const argvs: string[][] = [];
		const spawnExecutor = async (
			cmd: string[],
		): Promise<{
			exitCode: number | null;
			stdout: string;
			stderr: string;
		}> => {
			argvs.push(cmd);
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					result: "found the planted defect at syn-a.ts",
					usage: {
						input_tokens: 100,
						output_tokens: 40,
						cache_read_input_tokens: 5,
					},
					total_cost_usd: 0.0021,
					is_error: false,
				}),
				stderr: "",
			};
		};
		const manifest = await runMode(
			parseArgs([
				"--run",
				"--inventory",
				invPath,
				"--judge-prompt",
				jpPath,
				"--settings",
				stPath,
				"--out",
				dir,
				"--judge-url",
				`http://127.0.0.1:${judge.port}/v1/chat/completions`,
				"--before",
				DEFAULT_BEFORE_REV,
				"--after",
				"HEAD",
			]),
			{ spawnExecutor },
			synthTasks,
		);
		expect(argvs.length).toBe(4);
		expect(argvs[0]?.[0]).toBe("claude");
		expect(argvs[0]?.indexOf("--settings")).toBeGreaterThan(-1);
		const sysIdx = argvs[0]?.indexOf("--append-system-prompt") ?? -1;
		expect(argvs[0]?.[sysIdx + 1] ?? "").toContain(BENCH_CONTRACT);
		expect(manifest.arms.before.rev).toBe(DEFAULT_BEFORE_REV);
		expect(manifest.arms.after.rev).toBe("HEAD");
		expect(manifest.corpusSha).toBe(corpusSha(synthTasks));
		expect(manifest.runs.length).toBe(4);
		expect(manifest.runs[0]?.score?.perIssue[0]?.found).toBe(true);
		expect(manifest.runs[0]?.score?.falsePositives).toBe(1);
		const before = manifest.totals.before;
		expect(before.planted).toBe(1);
		expect(before.found).toBe(2);
		expect(before.falsePositives).toBe(2);
		expect(before.inputTokens).toBe(200);
		expect(before.outputTokens).toBe(80);
		expect(before.cacheReadTokens).toBe(10);
		expect(before.costUsd).toBeCloseTo(0.0042, 6);
		expect(judgeAuth).toBe("Bearer test-key");
		expect(judgeModelSeen).toBe("test-judge-model");
		expect(judgePacket).toBeGreaterThan(0);
		const mpath = join(dir, `${manifest.runId}.json`);
		expect(existsSync(mpath)).toBe(true);
		expect(statSync(mpath).mode & 0o777).toBe(0o600);
		judge.stop(true);
	});
});
