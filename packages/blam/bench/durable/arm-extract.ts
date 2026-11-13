// bench/durable/arm-extract.ts — W2971.3 extraction phase: the seed image
// seals patch-bearing runs through git commits (BLAM fixture contract —
// the agent works on a copy of /seed in its writable /workspace tmpfs and
// commits). While the container is still up, `git add -A && git diff
// --cached HEAD` IS the candidate patch; after stop it is unrecoverable
// (tmpfs dies with the container) — extraction ALWAYS runs before stop.
// Also reads the durable journal's pi.usage document for ledger tokens.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const run = promisify(execFile);

export interface ExtractResult {
	patchPath: string | null; // null = no sealed patch (honest no-patch)
	patchSha256: string | null;
}

/** Seal-and-extract the candidate patch from the live run container.
 *  Contract ladder: (1) git-sealed workspace diff; (2) an explicit *.patch
 *  artifact the agent wrote (a legitimate non-git repair style — seen live
 *  on a10); (3) null = no-patch (honest rejection). */
export async function extractPatch(
	containerName: string,
	outPath: string,
): Promise<ExtractResult> {
	const repo = await run("docker", [
		"exec",
		containerName,
		"sh",
		"-lc",
		"cd /workspace && git rev-parse --is-inside-work-tree 2>/dev/null || echo NOREPO",
	]).catch(() => ({ stdout: "NOREPO" }));
	if (repo.stdout.trim() === "true") {
		const seal = await run(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-lc",
				"cd /workspace && git add -A && git -c core.quotePath=false diff --cached HEAD --binary",
			],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		const patch = seal.stdout;
		if (patch.trim()) {
			writeFileSync(outPath, patch, { mode: 0o600 });
			return {
				patchPath: outPath,
				patchSha256: createHash("sha256").update(patch).digest("hex"),
			};
		}
	}
	const artifacts = await run("docker", [
		"exec",
		containerName,
		"sh",
		"-lc",
		"ls -1 /workspace/*.patch 2>/dev/null | head -1",
	]).catch(() => ({ stdout: "" }));
	const artifact = artifacts.stdout.trim();
	if (artifact) {
		const patch = await run(
			"docker",
			["exec", containerName, "cat", artifact],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		writeFileSync(outPath, patch, { mode: 0o600 });
		return {
			patchPath: outPath,
			patchSha256: createHash("sha256").update(patch).digest("hex"),
		};
	}
	return { patchPath: null, patchSha256: null };
}

export interface UsageTotals {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
}

/** Ledger tokens from the durable journal (pi.usage document). */
export function extractUsage(journalDir: string): UsageTotals {
	const stateDir = join(journalDir, "state");
	if (!existsSync(stateDir))
		return { input: null, output: null, cacheRead: null };
	let usage: { input: number; output: number; cacheRead: number } | null = null;
	for (const file of readdirSync(stateDir)) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(stateDir, file), "utf8").split("\n")) {
			if (!line.includes('"pi.usage"')) continue;
			try {
				const record = JSON.parse(line) as {
					payload?: {
						type?: string;
						value?: {
							usage?: { input?: number; output?: number; cacheRead?: number };
						};
					};
				};
				const u =
					record.payload?.type === "document"
						? record.payload.value?.usage
						: record.payload?.value?.usage;
				if (u && typeof u.input === "number") {
					usage = {
						input: u.input,
						output: u.output ?? 0,
						cacheRead: u.cacheRead ?? null,
					};
				}
			} catch {
				// torn trailing line — the next parseable usage wins
			}
		}
	}
	return usage ?? { input: null, output: null, cacheRead: null };
}

/** The gold patch for the judge's gold phase: baseCommit..fixCommit diff. */
export async function goldPatch(
	repoRoot: string,
	baseCommit: string,
	fixCommit: string,
	outPath: string,
): Promise<string> {
	const diff = await run(
		"git",
		["-C", repoRoot, "diff", "--binary", `${baseCommit}..${fixCommit}`],
		{ maxBuffer: 32 * 1024 * 1024 },
	);
	writeFileSync(outPath, diff.stdout, { mode: 0o600 });
	return outPath;
}
