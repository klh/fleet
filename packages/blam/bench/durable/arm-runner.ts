// bench/durable/arm-runner.ts — W2971.3 the mechanically redoable runner
// path: `bun packages/blam/bench/durable/arm-runner.ts --problem SPH-13926`
// can run, re-run, and re-run again; every attempt appends to the ledger
// and receipts so the record shows WHAT WORKED and WHAT DIDN'T. Fail-closed
// at every precondition; no silent ceilings.
// Usage: bun arm-runner.ts --problem <id> [--tier low|medium|high] [--attempts N]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadProblem } from "./problem-set.ts";
import {
	appendLedgerRow,
	attemptCount,
	readLedger,
	type LedgerRow,
	type Tier,
} from "./arm-ledger.ts";
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
		die(
			`missing ${LOCAL} (machine-local, 0600). Expected shape: {"repos":{"sphinx":"/abs/repo"},"identityUrl":"http://127.0.0.1:4599","mintCredentialFile":"/abs/mint-root.raw","image":"<digest-pinned ref>"}`,
		);
	}
	const parsed = JSON.parse(readFileSync(LOCAL, "utf8")) as Record<
		string,
		never
	>;
	for (const key of [
		"repos",
		"identityUrl",
		"mintCredentialFile",
		"image",
		"stateDir",
	]) {
		if (!(key in parsed)) die(`bench.local.json missing "${key}"`);
	}
	return parsed;
}

function freshArchive(
	repoRoot: string,
	baseCommit: string,
	outPath: string,
): string {
	// ONE git archive per attempt (#124443): fresh output, refuse existing
	if (existsSync(outPath))
		die(
			`fresh-archive violation: ${outPath} exists — each attempt gets its own export`,
		);
	execFileSync(
		"git",
		["-C", repoRoot, "archive", "--output", outPath, baseCommit],
		{ stdio: "pipe" },
	);
	const bytes = readFileSync(outPath);
	if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024)
		die(`archive size/type refused (${bytes.length} bytes)`);
	return createHash("sha256").update(bytes).digest("hex");
}

/** Seed dirs the repair surface never needs — PRUNED from the staged tree
 *  to fit the executor's seed caps (2000 files / 64MB). The FULL tree
 *  measured 2011 files: doc/ (206 files) goes; the anchor's archiveSha
 *  keeps full-tree provenance and the run receipt's seedDigest covers
 *  exactly the pruned staged tree — both surfaces stay honest. */
const PRUNE_SEED_DIRS = ["doc"];
function pruneSeed(seedRoot: string): void {
	for (const dir of PRUNE_SEED_DIRS) {
		rmSync(join(seedRoot, dir), { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const problemId = argv.includes("--problem")
		? argv[argv.indexOf("--problem") + 1]
		: die("--problem <id> required");
	const problem = loadProblem(DIR.problemSet, problemId);
	const local = loadLocal();
	const repoRoot = (local.repos as Record<string, string> | undefined)?.[
		problem.repo
	];
	if (!repoRoot || !existsSync(repoRoot))
		die(`repo root for "${problem.repo}" missing in bench.local.json`);
	mkdirSync(DIR.receipts, { recursive: true });
	mkdirSync(join(HERE, "ledger"), { recursive: true });
	mkdirSync(join(HERE, "ledger", "exports"), { recursive: true });

	// retained-negative problems REFUSE admission (oracle-isolation law)
	if (problem.retainedNegative) {
		const row = refusedRow(
			problem,
			"retained-negative control refuses admission",
		);
		appendLedgerRow(DIR.ledger, row);
		die(
			`${problem.id} is retainedNegative — admission refused (ledger row appended)`,
		);
	}

	// tier ladder: which tier does this attempt run at?
	const ladder = loadTierLadder(DIR.ladder);
	const tier = (
		argv.includes("--tier") ? argv[argv.indexOf("--tier") + 1] : null
	) as Tier | null;
	const chosen = tier ?? nextTier(ladder, DIR.ledger, problemId);
	const plan = ladder.tiers[chosen];
	const attempt = attemptCount(DIR.ledger, problemId) + 1;
	const prior = readLedger(DIR.ledger).filter((r) => r.problemId === problemId);
	console.log(
		`arm-runner: ${problemId} attempt ${attempt} tier=${chosen} (prior outcomes: ${prior.map((r) => r.outcome).join(", ") || "none"})`,
	);

	// fresh export + receipt of provenance
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const archivePath = join(
		HERE,
		"ledger",
		"exports",
		`${problemId}-a${attempt}-${stamp}.tar`,
	);
	const archiveSha = freshArchive(repoRoot, problem.baseCommit, archivePath);
	// stage THIS attempt's seed: fresh per-attempt dir, extract the archive
	// into it — the seedRoot is the EXTRACTED TREE, never the exports dir
	// (accumulated tars blew the executor's 64MB byte cap: the a1/a2
	// refusals). The leaf's scanSeedDir re-walks it for the run seedDigest.
	const seedRoot = join(
		HERE,
		"ledger",
		"seeds",
		`${problemId}-a${attempt}-${stamp}`,
	);
	if (existsSync(seedRoot))
		die(
			`fresh-seed violation: ${seedRoot} exists — each attempt gets its own staged tree`,
		);
	mkdirSync(seedRoot, { recursive: true });
	execFileSync("tar", ["-xf", archivePath, "-C", seedRoot], { stdio: "pipe" });
	pruneSeed(seedRoot);
	const image = String(local.image);
	const mintFile = String(local.mintCredentialFile);
	if (!existsSync(mintFile)) die(`mint credential file missing: ${mintFile}`);

	const marker = join(DIR.receipts, `${problemId}-a${attempt}-PENDING.md`);
	writeFileSync(
		marker,
		[
			`# ${problemId} attempt ${attempt} — ANCHOR`,
			`runId=TBD tier=${chosen}`,
			`base=${problem.baseCommit} archiveSha=${archiveSha}`,
			`export=${archivePath}`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);

	// ledger row FIRST (append-only law: every attempt is recorded even if
	// admission throws — infra refusals are part of the mechanical record)
	const row: LedgerRow = {
		ts: Date.now(),
		problemId,
		repo: problem.repo,
		attempt,
		tier: chosen,
		runId: crypto.randomUUID(),
		outcome: "refused",
		tokens: { input: null, output: null, cacheRead: null, total: null },
		hashes: {
			archiveSha256: archiveSha,
			imageDigest: image.slice(-24),
			judgeLogSha256: null,
			patchSha256: null,
		},
		wallClockMs: null,
		notes: `anchor attempt: fresh export + staged seed ${seedRoot}`,
	};
	appendLedgerRow(DIR.ledger, row);

	// admission: stage → leaf admitAndStart (in-tree production leaf) →
	// frozen 0600 admit receipt; on throw the leaf revokes the just-minted
	// key itself (abort-observing admit). Anchor row already retained.
	const { admitArm, persistAdmitReceipt } = await import("./arm-admit.ts");
	try {
		const { receipt, leaf } = await admitArm({
			runId: row.runId,
			issueText: problem.issueText,
			seedRoot,
			mintCredentialFile: mintFile,
			model: "glm-5.3-flash",
			wallClockMin: plan.wallClockMin,
			imageDigest: image,
		});
		const receiptPath = persistAdmitReceipt(
			DIR.receipts,
			problemId,
			attempt,
			receipt,
		);
		console.log(`arm-runner: ADMITTED ${receipt.runId} → ${receiptPath}`);
		writeFileSync(
			marker,
			[
				`# ${problemId} attempt ${attempt} — ADMITTED`,
				`runId=${receipt.runId} tier=${chosen}`,
				`archive=${archivePath} sha=${archiveSha}`,
				`seed=${seedRoot}`,
				`next: supervise → extract → judge`,
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		appendLedgerRow(DIR.ledger, {
			...row,
			ts: Date.now(),
			outcome: "admitted",
			notes: `admitted; receipt ${receiptPath}`,
		});

		// THIS process owns the durable job — it stays alive through the
		// whole pipeline; dying here kills the run mid-flight (a5 lesson)
		const { superviseRun } = await import("./arm-supervise.ts");
		console.log(
			`arm-runner: supervising run (deadline ${new Date(receipt.deadline).toISOString()})…`,
		);
		const supervised = await superviseRun(
			join(local.stateDir as string, "durable", receipt.runId),
			receipt.deadline,
			() => leaf.stopRun(receipt.runId),
		);
		console.log(
			`arm-runner: run ${supervised.state} in ${Math.round(supervised.wallClockMs / 1000)}s`,
		);

		// extract BEFORE stop (tmpfs /workspace dies with the container); on
		// timeout the run is already stopped/fenced by the supervise phase
		const { extractPatch, extractUsage, goldPatch } = await import(
			"./arm-extract.ts"
		);
		let patch: { patchPath: string | null; patchSha256: string | null } = {
			patchPath: null,
			patchSha256: null,
		};
		if (supervised.state === "completed") {
			patch = await extractPatch(
				receipt.containerName,
				join(DIR.receipts, `${problemId}-a${attempt}-patch.diff`),
			);
		}
		const usage = extractUsage(
			join(local.stateDir as string, "durable", receipt.runId),
		);
		console.log(
			`arm-runner: patch=${patch.patchSha256 ? patch.patchSha256.slice(0, 12) : "none"} usage in=${usage.input} out=${usage.output}`,
		);

		// isolated judge: base FAIL / gold PASS / candidate decides — three
		// fresh containers over the clean archive; verdict sha rides the ledger
		const { judgePhase, verdict } = await import("./arm-judge.ts");
		const judgeImage = String(local.judgeImage ?? "");
		if (!judgeImage)
			die(
				"bench.local.json missing judgeImage (bun judge-image.ts --problem … prints it)",
			);
		const judge = problem.judge as { tests: string[]; testFiles?: string[] };
		const tests = judge.tests;
		// hidden tests ship with the fix commit — extract them once per attempt
		const testFiles = judge.testFiles ?? [];
		const goldTestsDir = join(
			DIR.receipts,
			`${problemId}-a${attempt}-goldtests`,
		);
		mkdirSync(goldTestsDir, { recursive: true });
		for (const f of testFiles) {
			const content = execFileSync(
				"git",
				["-C", repoRoot, "show", `${problem.fixCommit}:${f}`],
				{ maxBuffer: 8 * 1024 * 1024 },
			);
			writeFileSync(join(goldTestsDir, f), content, { mode: 0o600 });
		}
		const timeoutMs = 300_000;
		const baseRc = (
			await judgePhase({
				image: judgeImage,
				archivePath,
				patchPath: null,
				tests,
				testFiles,
				goldTestsDir,
				workdir: "/workspace",
				receiptsDir: DIR.receipts,
				label: `${problemId}-a${attempt}-base`,
				timeoutMs,
			})
		).rc;
		const goldDiff = join(DIR.receipts, `${problemId}-a${attempt}-gold.diff`);
		await goldPatch(repoRoot, problem.baseCommit, problem.fixCommit, goldDiff);
		const goldRc = (
			await judgePhase({
				image: judgeImage,
				archivePath,
				patchPath: goldDiff,
				tests,
				testFiles,
				goldTestsDir,
				workdir: "/workspace",
				receiptsDir: DIR.receipts,
				label: `${problemId}-a${attempt}-gold`,
				timeoutMs,
			})
		).rc;
		let outcome: LedgerRow["outcome"];
		let candidateLogSha: string | null = null;
		try {
			if (!patch.patchPath) {
				outcome = "rejected"; // no sealed patch — honest no-patch rejection
			} else {
				const candidate = await judgePhase({
					image: judgeImage,
					archivePath,
					patchPath: patch.patchPath,
					tests,
					testFiles,
					goldTestsDir,
					workdir: "/workspace",
					receiptsDir: DIR.receipts,
					label: `${problemId}-a${attempt}-candidate`,
					timeoutMs,
				});
				candidateLogSha = candidate.logSha256;
				outcome = verdict(baseRc, goldRc, candidate.rc);
			}
		} catch (error) {
			outcome = "rejected"; // judge precondition drift (base/gold contract) — recorded, never silent
			console.error(
				`arm-runner: judge precondition drift — ${(error as Error).message.split("\n")[0]}`,
			);
		}
		if (supervised.state === "completed") await leaf.stopRun(receipt.runId);
		const finalRow: LedgerRow = {
			ts: Date.now(),
			problemId,
			repo: problem.repo,
			attempt,
			tier: chosen,
			runId: row.runId,
			outcome,
			tokens: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				total: (usage.input ?? 0) + (usage.output ?? 0) || null,
			},
			hashes: {
				archiveSha256: archiveSha,
				imageDigest: image.slice(-24),
				judgeLogSha256: candidateLogSha,
				patchSha256: patch.patchSha256,
			},
			wallClockMs: supervised.wallClockMs,
			notes: `supervise=${supervised.state} judge base=${baseRc} gold=${goldRc}${patch.patchSha256 ? ` candidate sha=${patch.patchSha256.slice(0, 12)}` : " no-patch"}`,
		};
		appendLedgerRow(DIR.ledger, finalRow);
		writeFileSync(
			marker,
			[
				`# ${problemId} attempt ${attempt} — ${outcome.toUpperCase()}`,
				`runId=${receipt.runId} tier=${chosen} wall=${supervised.wallClockMs}ms`,
				`patch=${patch.patchSha256 ?? "none"} judgeLog=${candidateLogSha ?? "none"}`,
				`judge: base=${baseRc} gold=${goldRc}`,
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		console.log(`arm-runner: ${outcome.toUpperCase()} — ledger row appended`);
	} catch (error) {
		die(
			`admission refused (anchor row retained): ${(error as Error).message.split("\n")[0]}`,
		);
	}
}
function refusedRow(
	problem: { id: string; repo: string },
	note: string,
): LedgerRow {
	return {
		ts: Date.now(),
		problemId: problem.id,
		repo: problem.repo,
		attempt: attemptCount(DIR.ledger, problem.id) + 1,
		tier: "low",
		runId: crypto.randomUUID(),
		outcome: "refused",
		tokens: { input: null, output: null, cacheRead: null, total: null },
		hashes: {
			archiveSha256: null,
			imageDigest: null,
			judgeLogSha256: null,
			patchSha256: null,
		},
		wallClockMs: null,
		notes: note,
	};
}
main().catch((error) =>
	die(error instanceof Error ? error.message : String(error)),
);
