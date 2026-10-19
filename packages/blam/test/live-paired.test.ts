import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gitRaw,
	runLivePaired,
	tokensFromOutput,
	usageFromOutput,
	type LiveManifest,
} from "../bench/paired/live.ts";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
	return new TextDecoder().decode(p.stdout).trim();
}

function fixture(): LiveManifest {
	const root = mkdtempSync(join(tmpdir(), "blam-live-test-"));
	roots.push(root);
	const repo = join(root, "repo");
	const outputDir = join(root, "out");
	Bun.spawnSync(["mkdir", "-p", repo]);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "BLAM test");
	writeFileSync(join(repo, "README.md"), "task fixture\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "fixture");
	return {
		repo,
		baseRef: "HEAD",
		task: "Write the word done to result.txt",
		model: "fixture-model",
		baseline: "base",
		candidate: "candidate",
		reps: 3,
		executor: [
			"bun",
			"-e",
			"import{writeFileSync}from'node:fs';const p=process.argv[1];writeFileSync('result.txt','done\\n');console.log(JSON.stringify({usage:{total_tokens:p.includes('candidate')?100:200}}))",
			"{prompt}",
		],
		judge: [
			"bun",
			"-e",
			"import{readFileSync}from'node:fs';process.exit(readFileSync('result.txt','utf8')==='done\\n'?0:1)",
		],
		timeoutMs: 10_000,
		outputDir,
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("BLAM live paired runner", () => {
	test("raw patch output remains applicable after capture", () => {
		const manifest = fixture();
		writeFileSync(join(manifest.repo, "README.md"), "changed fixture\n");
		const patch = gitRaw(manifest.repo, "diff", "--binary", "HEAD");
		expect(patch.endsWith("\n")).toBe(true);
		git(manifest.repo, "checkout", "--", "README.md");
		const applied = Bun.spawnSync(["git", "-C", manifest.repo, "apply", "-"], {
			stdin: new TextEncoder().encode(patch),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(new TextDecoder().decode(applied.stderr)).toBe("");
		expect(applied.exitCode).toBe(0);
		expect(readFileSync(join(manifest.repo, "README.md"), "utf8")).toBe(
			"changed fixture\n",
		);
	});

	test("isolates each arm at the same revision and promotes measured lift", async () => {
		const manifest = fixture();
		const report = await runLivePaired(manifest);
		expect(report.receipts).toHaveLength(6);
		expect(report.receipts.map((r) => r.arm)).toEqual([
			"baseline",
			"candidate",
			"candidate",
			"baseline",
			"baseline",
			"candidate",
		]);
		expect(new Set(report.receipts.map((r) => r.baseSha)).size).toBe(1);
		expect(report.receipts.every((r) => r.judgeExit === 0)).toBe(true);
		expect(
			report.receipts.every((r) =>
				readFileSync(r.patchFile, "utf8").includes("result.txt"),
			),
		).toBe(true);
		expect(report.lift?.tokensSaved).toBe(100);
		expect(report.failures).toEqual({ baseline: 0, candidate: 0 });
		expect(report.promotion.promote).toBe(true);
		expect(
			JSON.parse(readFileSync(join(manifest.outputDir, "report.json"), "utf8"))
				.receipts,
		).toHaveLength(6);
	});

	test("a candidate that fails validation cannot promote on token savings", async () => {
		const manifest = fixture();
		manifest.executor[2] = manifest.executor[2].replace(
			"'done\\n'",
			"p.includes('candidate')?'wrong\\n':'done\\n'",
		);
		const report = await runLivePaired(manifest);
		expect(report.promotion.promote).toBe(false);
		expect(report.failures.candidate).toBe(3);
		expect(report.promotion.why).toMatch(/candidate failed/);
	});

	test("patch captures agent output before judge mutations", async () => {
		const manifest = fixture();
		manifest.reps = 1;
		manifest.judge = [
			"bun",
			"-e",
			"import{readFileSync,writeFileSync}from'node:fs';const ok=readFileSync('result.txt','utf8')==='done\\n';writeFileSync('judge-only.txt','private');process.exit(ok?0:1)",
		];
		const report = await runLivePaired(manifest);
		for (const receipt of report.receipts)
			expect(readFileSync(receipt.patchFile, "utf8")).not.toContain(
				"judge-only.txt",
			);
	});

	test("missing token accounting refuses promotion", async () => {
		const manifest = fixture();
		manifest.executor[2] = manifest.executor[2].replace(
			"console.log(JSON.stringify({usage:{total_tokens:p.includes('candidate')?100:200}}))",
			"console.log('no usage')",
		);
		const report = await runLivePaired(manifest);
		expect(report.pairs).toHaveLength(0);
		expect(report.promotion.promote).toBe(false);
	});

	test("zero usage from a routed model is missing accounting", async () => {
		const manifest = fixture();
		manifest.executor[2] = manifest.executor[2].replace(
			"p.includes('candidate')?100:200",
			"0",
		);
		const report = await runLivePaired(manifest);
		expect(report.receipts.every((r) => r.tokens === null)).toBe(true);
		expect(report.pairs).toHaveLength(0);
		expect(report.promotion.promote).toBe(false);
	});

	test("rejects a judge that can read harness text", async () => {
		const manifest = fixture();
		manifest.judge.push("{prompt}");
		expect(runLivePaired(manifest)).rejects.toThrow(/judge must not receive/);
	});

	test("reads token totals from JSONL usage", () => {
		expect(
			tokensFromOutput(
				'{"usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":6}}',
			),
		).toBe(20);
		expect(tokensFromOutput("no accounting")).toBeNull();
		expect(
			usageFromOutput(
				'{"type":"turn.completed","usage":{"total_tokens":90,"cached_input_tokens":60}}',
			),
		).toEqual({
			tokens: 90,
			cacheReadTokens: 60,
			cacheWriteTokens: null,
		});
	});

	test("private judge scores partial quality without turning a failure into promotion", async () => {
		const manifest = fixture();
		manifest.judge = [
			"bun",
			"-e",
			"console.log(JSON.stringify({score:0.5}));process.exit(1)",
		];
		const report = await runLivePaired(manifest);
		expect(report.receipts.every((r) => r.quality === 0.5)).toBe(true);
		expect(report.lift?.correctDelta).toBe(0);
		expect(report.promotion.promote).toBe(false);
	});
});
