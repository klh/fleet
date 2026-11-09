// Infrastructure-only workspace preparation probe, not sandbox or agent proof.
import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";
import { git, command } from "../paired/live.ts";
import type { RunnerReceipt } from "./contracts.ts";
import { evaluateRunner } from "./evaluate.ts";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
type Sample = {
	rep: number;
	arm: "baseline" | "candidate";
	position: number;
	repoRevision: string;
	experiment: string;
	readyMs: number;
	wallMs: number;
	artifact: string;
	execution: { exit: number; timedOut: boolean };
};
function makeReceipt(s: Sample): RunnerReceipt {
	return {
		version: 1,
		experiment: s.experiment,
		track: "infrastructure",
		arm: s.arm,
		rep: s.rep,
		order: s.position === 0 ? 0 : 1,
		seedDigest: digest(
			`${s.arm}:${readFileSync(import.meta.filename, "utf8")}`,
		),
		jobId: randomUUID(),
		setup: {
			taskDigest: digest("read unit-127.txt"),
			repoRevision: s.repoRevision,
			host: hostname(),
			runtime: `bun-${Bun.version}`,
			model: "none",
			provider: "none",
			cacheCondition: "resident-source-os-cache-uncontrolled",
			policyDigest: digest("no-model-no-sandbox"),
			dependenciesDigest: digest("git-only"),
			judgeDigest: digest("exact fixture contents"),
		},
		readyMs: s.execution.exit === 0 ? s.readyMs : null,
		firstUsefulMs: s.execution.exit === 0 ? s.wallMs : null,
		wallMs: s.wallMs,
		rssBytes: null,
		diskBytes: null,
		usage: null,
		quality: s.artifact === "unit 127\n".repeat(100) ? 1 : 0,
		exitCode: s.execution.exit,
		timedOut: s.execution.timedOut,
		isolationFailures: null,
		artifactDigest: digest(s.artifact),
		evidence: "workspace-copy-only; no isolation claim",
	};
}
function saveResults(outputDir: string, receipts: RunnerReceipt[]) {
	mkdirSync(outputDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(outputDir, "receipts.ndjson"),
		`${receipts.map((r) => JSON.stringify(r)).join("\n")}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	const report = evaluateRunner(receipts);
	writeFileSync(
		join(outputDir, "report.json"),
		`${JSON.stringify(report, null, 2)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	return report;
}

if (import.meta.main) {
	const outputDir = process.argv[2];
	if (!outputDir)
		throw new Error("usage: bun workspace-smoke.ts output-dir [reps]");
	console.log(
		JSON.stringify(
			await workspaceSmoke(outputDir, Number(process.argv[3] ?? 12)),
		),
	);
}
export async function workspaceSmoke(outputDir: string, reps = 12) {
	if (!Number.isInteger(reps) || reps < 3 || reps > 100)
		throw new Error("reps must be 3..100");
	const home = mkdtempSync(join(tmpdir(), "blam-workspace-"));
	const source = join(home, "source");
	mkdirSync(source);
	git(source, "init", "-q");
	git(source, "config", "user.name", "Benchmark");
	git(source, "config", "user.email", "benchmark@example.invalid");
	for (let i = 0; i < 128; i++)
		writeFileSync(join(source, `unit-${i}.txt`), `unit ${i}\n`.repeat(100));
	git(source, "add", ".");
	git(source, "commit", "-qm", "fixture");
	const repoRevision = git(source, "rev-parse", "HEAD");
	const experiment = `workspace-${randomUUID()}`;
	const receipts: RunnerReceipt[] = [];
	try {
		for (let rep = 0; rep < reps; rep++) {
			const order =
				rep % 2
					? (["candidate", "baseline"] as const)
					: (["baseline", "candidate"] as const);
			for (const [position, arm] of order.entries()) {
				const workspace = join(home, `${rep}-${arm}`);
				const started = performance.now();
				const argv =
					arm === "baseline"
						? ["git", "clone", "--no-hardlinks", "--quiet", source, workspace]
						: [
								"git",
								"-C",
								source,
								"worktree",
								"add",
								"--detach",
								"--quiet",
								workspace,
								repoRevision,
							];
				const execution = await command(argv, home, 30_000, {});
				const readyMs = performance.now() - started;
				const artifact =
					execution.exit === 0
						? readFileSync(join(workspace, "unit-127.txt"), "utf8")
						: "";
				const wallMs = performance.now() - started;
				receipts.push(
					makeReceipt({
						rep,
						arm,
						position,
						repoRevision,
						experiment,
						readyMs,
						wallMs,
						artifact,
						execution,
					}),
				);
			}
		}
		return saveResults(outputDir, receipts);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}
