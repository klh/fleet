// bench/durable/arm-ledger.ts — W2971.3 append-only arm ledger (NDJSON).
// The mechanical record of WHAT WORKED and WHAT DIDN'T: one JSON line per
// arm attempt, plus judge verdict lines. Never rewritten — attempts append;
// receipts are separate markdown files keyed by problem+attempt. Decision
// grade: every ACCEPTED row must carry the judge sha so a claim is
// re-verifiable from the ledger alone.
import { appendFileSync, closeSync, openSync, statSync } from "node:fs";
import { z } from "zod";

export const TierSchema = z.enum(["low", "medium", "high"]);
export type Tier = z.infer<typeof TierSchema>;

export const LedgerRowSchema = z.strictObject({
	ts: z.number(), // Date.now()
	problemId: z.string().min(1),
	repo: z.string().min(1),
	attempt: z.number().int().positive(),
	tier: TierSchema,
	runId: z.string().uuid(),
	outcome: z.enum([
		"admitted", // run started, no verdict yet
		"accepted", // judge: baseFAIL/goldPASS/candidatePASS
		"rejected", // judge: candidate failed hidden tests (real pytest RC)
		"judge-error", // judge could not run (infra) — never silently skipped
		"expired", // lifecycle deadline hit without completion
		"parked", // leaf auto-park (supervisor loss etc.)
		"refused", // pre-admission refusal (retained negative, precondition)
	]),
	tokens: z.strictObject({
		input: z.number().nullable(),
		output: z.number().nullable(),
		cacheRead: z.number().nullable(),
		total: z.number().nullable(), // input+output EXCLUDING cacheRead (delta law)
	}),
	hashes: z.strictObject({
		archiveSha256: z.string().length(64).nullable(),
		imageDigest: z.string().min(8).nullable(),
		judgeLogSha256: z.string().length(64).nullable(),
		patchSha256: z.string().length(64).nullable(),
	}),
	wallClockMs: z.number().int().nonnegative().nullable(),
	notes: z.string().max(2000).default(""),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;

/** Append one row; validates on write so the ledger can never drift. */
export function appendLedgerRow(path: string, row: LedgerRow): void {
	const parsed = LedgerRowSchema.safeParse(row);
	if (!parsed.success) {
		throw new Error(`ledger row drift refused:\n${parsed.error.message}`);
	}
	const fd = openSync(path, "a");
	try {
		appendFileSync(fd, `${JSON.stringify(parsed.data)}\n`);
	} finally {
		closeSync(fd);
	}
}

/** Read all rows; a corrupt line fails LOUD naming the line number. */
export function readLedger(path: string): LedgerRow[] {
	let raw: string;
	try {
		raw = require("node:fs").readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const rows: LedgerRow[] = [];
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	for (const [index, line] of lines.entries()) {
		const parsed = LedgerRowSchema.safeParse(JSON.parse(line));
		if (!parsed.success) {
			throw new Error(
				`ledger corrupt at ${path}:${index + 1}:\n${parsed.error.message}`,
			);
		}
		rows.push(parsed.data);
	}
	return rows;
}

/** Attempt counter per problem: how many rows exist (any outcome). */
export function attemptCount(path: string, problemId: string): number {
	return readLedger(path).filter((row) => row.problemId === problemId).length;
}

export function ledgerSizeBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
