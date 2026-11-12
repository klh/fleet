// bench/durable/arm-judge.ts — W2971.3 isolated judge (oracle-isolation
// law): every phase runs in a FRESH container from the clean archive (no
// .git, no gold objects), hidden tests live only in the judge container,
// real pytest exit codes (no pipes), logs land in receipts + sha256 into
// the ledger. Verdict triple: base must FAIL the tests, gold must PASS,
// candidate PASS ⇒ accepted.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const run = promisify(execFile);

export interface JudgePhaseInput {
	image: string;
	archivePath: string; // clean-base source.tar (sha verified by caller)
	patchPath: string | null; // null ⇒ base phase (no patch)
	tests: string[];
	workdir: string; // extracted tree root inside the container
	receiptsDir: string;
	label: string; // e.g. SPH-13926-a2-base
	timeoutMs: number;
}

export interface JudgePhaseResult {
	phase: "base" | "gold" | "candidate";
	rc: number; // real pytest exit code
	logPath: string;
	logSha256: string;
	seconds: number;
}

/** Apply patch via git-free unified diff (patch(1) inside the container). */
const PATCH_CMD = (patch: boolean, workdir: string, tests: string) =>
	patch
		? [
			"sh",
			"-lc",
			`tar -xf /seed/source.tar -C /workspace && cd ${workdir} && patch -p1 --forward < /patch/candidate.diff >/dev/null 2>&1; python -m pytest ${tests} -x -q; echo RC=$?`,
		]
		: [
			"sh",
			"-lc",
			`tar -xf /seed/source.tar -C /workspace && cd ${workdir} && python -m pytest ${tests} -x -q; echo RC=$?`,
		];

export async function judgePhase(input: JudgePhaseInput): Promise<JudgePhaseResult> {
	const { image, archivePath, patchPath, tests, workdir, receiptsDir, label, timeoutMs } = input;
	mkdirSync(receiptsDir, { recursive: true });
	const argv = [
		"run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
		"--user", "1000:1000", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
		"--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
		"--tmpfs", "/workspace:rw,noexec,nosuid,size=128m,uid=1000,gid=1000",
		"-v", `${archivePath}:/seed/source.tar:ro`,
		...(patchPath ? ["-v", `${patchPath}:/patch/candidate.diff:ro`] : []),
		image,
		...PATCH_CMD(patchPath !== null, workdir, tests.join(" ")),
	];
	const started = Date.now();
	let rc = 1;
	let log = "";
	try {
		const out = await run("docker", argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
		log = `${out.stdout}\n${out.stderr}`;
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: number };
		log = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
		rc = err.code ?? 1;
	}
	const tail = log.match(/RC=(\d+)\s*$/);
	if (tail) rc = Number(tail[1]); // real pytest RC, not docker's
	const seconds = Math.round((Date.now() - started) / 1000);
	const logPath = join(receiptsDir, `${label}.log`);
	writeFileSync(logPath, log, { mode: 0o600 });
	return {
		phase: patchPath === null ? "base" : label.includes("gold") ? "gold" : "candidate",
		rc,
		logPath,
		logSha256: createHash("sha256").update(log).digest("hex"),
		seconds,
	};
}

export function verdict(base: number, gold: number, candidate: number): "accepted" | "rejected" {
	// base must FAIL (rc≠0), gold must PASS (rc=0), candidate decides
	if (base === 0 || gold !== 0) throw new Error(`judge precondition drift: base rc=${base} (expect ≠0), gold rc=${gold} (expect 0)`);
	return candidate === 0 ? "accepted" : "rejected";
}
