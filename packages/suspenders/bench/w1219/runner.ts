// bench/w1219/runner.ts — the benchmark loop: candidates × questions over
// the sink replica; exec-rate + match-rate + p50/p95 per candidate; raw
// run JSON to results/. Run: bun bench/w1219/runner.ts
// Decision rule (owner directive: "fast and efficient"): among candidates
// within 10 points of the best match-rate, the fastest p50 wins.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { QUESTIONS, type Question } from "./questions.ts";
import {
	lintSql,
	execSql,
	rowsMatch,
	percentile,
	extractSql,
} from "./kit.ts";
import { buildReplica } from "./replica.ts";
import { buildPrompt } from "./prompt.ts";
import {
	ollamaCandidate,
	openaiCandidate,
	anthropicCandidate,
} from "./candidates.ts";

const ro = (path: string): Database =>
	new Database(path, { readonly: true });

interface Attempt {
	q: string;
	lang: string;
	ms: number;
	sql: string;
	valid: boolean;
	match: boolean;
	error?: string;
}

export interface RunSummary {
	name: string;
	kind: string;
	execRate: number;
	matchRate: number;
	p50Ms: number;
	p95Ms: number;
	attempts: Attempt[];
}

const goldMap = (
	db: Database,
): Map<string, Record<string, unknown>[]> => {
	const m = new Map<string, Record<string, unknown>[]>();
	for (const q of QUESTIONS) {
		const g = execSql(db, q.gold_sql);
		if (!g.ok) throw new Error(`gold ${q.id} fails: ${g.error}`);
		m.set(q.id, g.rows);
	}
	return m;
};

/** Lint + execute + compare into attempt fields. */
function verdict(
	sql: string,
	error: string | undefined,
	db: Database,
	gold: Record<string, unknown>[],
): { valid: boolean; match: boolean; error?: string } {
	if (!sql) return { valid: false, match: false, error: error ?? "no SQL" };
	const lint = lintSql(sql);
	if (!lint.ok)
		return { valid: false, match: false, error: error ?? `lint: ${lint.why}` };
	const res = execSql(db, sql);
	if (!res.ok)
		return { valid: false, match: false, error: res.error };
	return {
		valid: true,
		match: rowsMatch(res.rows, gold),
		error,
	};
}

/** One candidate over ALL questions: warmup (untimed) then timed loop. */
async function runOne(
	c: Candidate,
	schema: string,
	golds: Map<string, Record<string, unknown>[]>,
	db: Database,
): Promise<RunSummary> {
	const attempts: Attempt[] = [];
	// warmup — model load + prompt cache must not pollute the latency rows
	await c.call(buildPrompt(schema, QUESTIONS[0].q)).catch(() => {});
	for (const q of QUESTIONS) {
		attempts.push(
			await measureOne(c, buildPrompt(schema, q.q), golds.get(q.id) ?? [], db, q),
		);
	}
	const times = attempts.map((a) => a.ms);
	const n = attempts.length;
	return {
		name: c.name,
		kind: c.kind,
		execRate: attempts.filter((a) => a.valid).length / n,
		matchRate: attempts.filter((a) => a.match).length / n,
		p50Ms: percentile(times, 50),
		p95Ms: percentile(times, 95),
		attempts,
	};
}

/** Full run: replica → golds → per-candidate loops → summary. */
export async function runBench(
	candidates: Candidate[],
): Promise<RunSummary[]> {
	const root = mkdtempSync(join(tmpdir(), "w1219-run-"));
	const rep = await buildReplica(root);
	const db = new Database(rep.dbPath, { readonly: true });
	const golds = goldMap(db);
	const out: RunSummary[] = [];
	for (const c of candidates) out.push(await runOne(c, rep.schemaText, golds, db));
	db.close();
	rep.close();
	return out;
}

/** One candidate × one question: call → extract → lint → ro-exec → compare.
 *  Every failure is a recorded attempt, never a thrown run. */
async function measureOne(
	c: Candidate,
	prompt: string,
	gold: Record<string, unknown>[],
	db: Database,
	question: Question,
): Promise<Attempt> {
	const t0 = performance.now();
	let sql = "";
	let error: string | undefined;
	try {
		sql = extractSql(await c.call(prompt));
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	const ms = Math.round(performance.now() - t0);
	return { q: question.id, lang: question.lang, ms, sql, ...verdict(sql, error, db, gold) };
}

const RESULTS_DIR = join(import.meta.dir, "results");
