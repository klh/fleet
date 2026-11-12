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
	tests: string[]; // pytest -k names (the hidden selectors)
	testFiles: string[]; // repo-relative files copied from the gold commit into every phase
	goldTestsDir: string; // host dir holding testFiles (extracted from fixCommit)
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

/** Apply patch via git-free unified diff (patch(1) inside the container).
 *  SPH-style hidden tests ship WITH the fix commit — every phase copies
 *  the gold test files over the workspace BEFORE pytest, so the base
 *  phase fails by ASSERTION (the real contract), never by file-not-found. */
const phaseCmd = (input: JudgePhaseInput) => {
	const parts = [
		"tar -xf /seed/source.tar -C /workspace",
		"cd /workspace",
		...input.testFiles.map(
			(f) =>
				`mkdir -p $(dirname /workspace/${f}) && cp /goldtests/${f} /workspace/${f}`,
		),
	];
	if (input.patchPath) {
		parts.push(
			"patch -p1 --forward --quiet < /patch/candidate.diff || patch_rc=$?",
		);
	}
	parts.push(
		`python -m pytest ${input.testFiles.join(" ")} -k "${input.tests.join(" or ")}" -x -q; echo RC=$?`,
	);
	return ["sh", "-lc", parts.join(" && ")];
};

export async function judgePhase(
	input: JudgePhaseInput,
): Promise<JudgePhaseResult> {
	const {
		image,
		archivePath,
		patchPath,
		goldTestsDir,
		receiptsDir,
		label,
		timeoutMs,
	} = input;
	mkdirSync(receiptsDir, { recursive: true });
	const argv = [
		"run",
		"--rm",
		"--network",
		"none",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--user",
		"1000:1000",
		"--memory",
		"512m",
		"--cpus",
		"1",
		"--pids-limit",
		"128",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
		"--tmpfs",
		"/workspace:rw,noexec,nosuid,size=128m,uid=1000,gid=1000",
		"-v",
		`${archivePath}:/seed/source.tar:ro`,
		"-v",
		`${goldTestsDir}:/goldtests:ro`,
		...(patchPath ? ["-v", `${patchPath}:/patch/candidate.diff:ro`] : []),
		image,
		...phaseCmd(input),
	];
	const started = Date.now();
	let rc = 1;
	let log = "";
	try {
		const out = await run("docker", argv, {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
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
		phase:
			patchPath === null
				? "base"
				: label.includes("gold")
					? "gold"
					: "candidate",
		rc,
		logPath,
		logSha256: createHash("sha256").update(log).digest("hex"),
		seconds,
	};
}

export function verdict(
	base: number,
	gold: number,
	candidate: number,
): "accepted" | "rejected" {
	// base must FAIL (rc≠0), gold must PASS (rc=0), candidate decides
	if (base === 0 || gold !== 0)
		throw new Error(
			`judge precondition drift: base rc=${base} (expect ≠0), gold rc=${gold} (expect 0)`,
		);
	return candidate === 0 ? "accepted" : "rejected";
}
