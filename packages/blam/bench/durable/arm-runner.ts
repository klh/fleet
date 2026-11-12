// bench/durable/arm-runner.ts — W2971.3 the mechanically redoable runner
// path: `bun packages/blam/bench/durable/arm-runner.ts --problem SPH-13926`
// can run, re-run, and re-run again; every attempt appends to the ledger
// and receipts so the record shows WHAT WORKED and WHAT DIDN'T. Fail-closed
// at every precondition; no silent ceilings.
// Usage: bun arm-runner.ts --problem <id> [--tier low|medium|high] [--attempts N]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProblem } from "./problem-set.ts";
import { appendLedgerRow, attemptCount, readLedger, type LedgerRow, type Tier } from "./arm-ledger.ts";
import { nextTier, loadTierLadder } from "./tier-ladder.ts";

const HERE = import.meta.dir;
const DIR = {
	problemSet: join(HERE, "problem-sets.json"),
	ladder: join(HERE, "tier-ladder.json"),
	ledger: join(HERE, "ledger", "arms.ndjson"),
	receipts: join(HERE, "ledger", "receipts"),
};
// machine-local, 0600, never committed (like buckle-spoke.env) — holds
// {repos:{sphinx:"/abs/partial-clone"}, identityUrl, mintCredentialFile, image}
const LOCAL = join(HERE, "bench.local.json");

const die = (m: string): never => {
	console.error(`arm-runner: REFUSED — ${m}`);
	process.exit(2);
};

function loadLocal(): Record<string, never> {
	if (!existsSync(LOCAL)) {
		die(`missing ${LOCAL} (machine-local, 0600). Expected shape: {"repos":{"sphinx":"/abs/repo"},"identityUrl":"http://127.0.0.1:4599","mintCredentialFile":"/abs/mint-root.raw","image":"<digest-pinned ref>"}`);
	}
	const parsed = JSON.parse(readFileSync(LOCAL, "utf8")) as Record<string, never>;
	for (const key of ["repos", "identityUrl", "mintCredentialFile", "image"]) {
		if (!(key in parsed)) die(`bench.local.json missing "${key}"`);
	}
	return parsed;
}

function freshArchive(repoRoot: string, baseCommit: string, outPath: string): string {
	// ONE git archive per attempt (#124443): fresh output, refuse existing
	if (existsSync(outPath)) die(`fresh-archive violation: ${outPath} exists — each attempt gets its own export`);
	execFileSync("git", ["-C", repoRoot, "archive", "--output", outPath, baseCommit], { stdio: "pipe" });
	const bytes = readFileSync(outPath);
	if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) die(`archive size/type refused (${bytes.length} bytes)`);
	return createHash("sha256").update(bytes).digest("hex");
}

function main(): void {
	const argv = process.argv.slice(2);
	const problemId = argv.includes("--problem") ? argv[argv.indexOf("--problem") + 1] : die("--problem <id> required");
	const problem = loadProblem(DIR.problemSet, problemId);
	const local = loadLocal();
	const repoRoot = (local.repos as Record<string, string> | undefined)?.[problem.repo];
	if (!repoRoot || !existsSync(repoRoot)) die(`repo root for "${problem.repo}" missing in bench.local.json`);
	mkdirSync(DIR.receipts, { recursive: true });
	mkdirSync(join(HERE, "ledger"), { recursive: true });

	// retained-negative problems REFUSE admission (oracle-isolation law)
	if (problem.retainedNegative) {
		const row = refusedRow(problem, "retained-negative control refuses admission");
		appendLedgerRow(DIR.ledger, row);
		die(`${problem.id} is retainedNegative — admission refused (ledger row appended)`);
	}

	// tier ladder: which tier does this attempt run at?
	const ladder = loadTierLadder(DIR.ladder);
	const tier = (argv.includes("--tier") ? argv[argv.indexOf("--tier") + 1] : null) as Tier | null;
	const chosen = tier ?? nextTier(ladder, DIR.ledger, problemId);
	const plan = ladder.tiers[chosen];
	const attempt = attemptCount(DIR.ledger, problemId) + 1;
	const prior = readLedger(DIR.ledger).filter((r) => r.problemId === problemId);
	console.log(`arm-runner: ${problemId} attempt ${attempt} tier=${chosen} (prior outcomes: ${prior.map((r) => r.outcome).join(", ") || "none"})`);

	// fresh export + receipt of provenance
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const archivePath = join(HERE, "ledger", "exports", `${problemId}-a${attempt}-${stamp}.tar`);
	const archiveSha = freshArchive(repoRoot, problem.baseCommit, archivePath);
	const image = String(local.image);
	const mintFile = String(local.mintCredentialFile);
	if (!existsSync(mintFile)) die(`mint credential file missing: ${mintFile}`);

	// admission happens through the installed production leaf; the driver
	// hands off to the leaf service runner with the staged archive + scoped
	// key lifecycle (mint → run → revoke) — see README for the runner path.
	// Until the leaf call is invoked here, the runner anchors the path
	// mechanically: export → ledger(admitted-attempt) → exit 0 marker file.
	// admission: stage → leaf admitAndStart (in-tree production leaf) →
	// frozen 0600 admit receipt. Supervise/extract/judge are the next
	// phases, each re-runnable from the receipt (done-and-redone law).
	const { admitArm, persistAdmitReceipt } = await import("./arm-admit.ts");
	try {
		const receipt = await admitArm({
			runId: row.runId,
			issueText: problem.issueText,
			seedRoot: join(HERE, "ledger", "exports"),
			mintCredentialFile: mintFile,
			model: "glm-5.3-flash",
			wallClockMin: plan.wallClockMin,
			imageDigest: image,
		});
		const receiptPath = persistAdmitReceipt(DIR.receipts, problemId, attempt, receipt);
		console.log(`arm-runner: ADMITTED ${receipt.runId} → ${receiptPath}`);
		writeFileSync(marker, [
			`# ${problemId} attempt ${attempt} — ADMITTED`,
			`runId=${receipt.runId} tier=${chosen}`,`,
			`archive=${archivePath} sha=${archiveSha}`,
			`next: supervise → extract → judge`,
			"",
		].join("\n"), { mode: 0o600 });
	} catch (error) {
		die(`admission refused: ${(error as Error).message.split("\n")[0]}`);
	}
	const row: LedgerRow = {
		ts: Date.now(), problemId, repo: problem.repo, attempt, tier: chosen,
		runId: crypto.randomUUID(), outcome: "refused",
		tokens: { input: null, output: null, cacheRead: null, total: null },
		hashes: { archiveSha256: archiveSha, imageDigest: image.slice(-24), judgeLogSha256: null, patchSha256: null },
		wallClockMs: null,
		notes: "anchor attempt: export+ledger done; leaf admission handoff next (W2971.3 runner path)",
	};
	appendLedgerRow(DIR.ledger, row);
	console.log(`arm-runner: ledger row appended (${DIR.ledger}); marker ${marker}`);
}
function refusedRow(problem: { id: string; repo: string }, note: string): LedgerRow {
	return {
		ts: Date.now(), problemId: problem.id, repo: problem.repo,
		attempt: attemptCount(DIR.ledger, problem.id) + 1, tier: "low",
		runId: crypto.randomUUID(), outcome: "refused",
		tokens: { input: null, output: null, cacheRead: null, total: null },
		hashes: { archiveSha256: null, imageDigest: null, judgeLogSha256: null, patchSha256: null },
		wallClockMs: null, notes: note,
	};
}
main();
