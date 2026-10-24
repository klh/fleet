// bench/w1219/kit.ts — the pure bench face: ro-SQL lint (the W1218
// consumer contract), read-only execution over the sink replica, order-
// insensitive result comparison, and latency percentiles.
import type { Database } from "bun:sqlite";

export interface LintVerdict {
	ok: boolean;
	why?: string;
}

/** The W1218 consumer contract: SELECT/WITH-only, one statement, no
 *  mutation/attach words anywhere in the text. */
export function lintSql(sql: string): LintVerdict {
	const s = sql.trim();
	if (!s) return { ok: false, why: "empty" };
	if (!/^(SELECT|WITH)\b/i.test(s)) return { ok: false, why: "not read-only" };
	if (s.includes(";")) return { ok: false, why: "multi-statement" };
	if (
		/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i.test(
			s,
		)
	)
		return { ok: false, why: "mutation word" };
	return { ok: true };
}

/** Read-only execution over the sink replica — the bench's stand-in for the
 *  sink's own ro-SQL face. Errors come back as a verdict, never a throw. */
export function execSql(
	db: Database,
	sql: string,
): { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string } {
	try {
		return { ok: true, rows: db.query(sql).all() };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Order-insensitive VALUE-ONLY comparison (Spider exec-match convention —
 *  column aliases are free): numbers round to 6dp, rows become sorted value
 *  vectors, multisets compared as sorted JSON lines. */
export function rowsMatch(
	a: Record<string, unknown>[],
	b: Record<string, unknown>[],
): boolean {
	const norm = (rows: Record<string, unknown>[]): string[] =>
		rows
			.map((r) =>
				JSON.stringify(
					Object.values(r).map((v) =>
						typeof v === "number" ? Number(v.toFixed(6)) : v,
					),
				),
			)
			.sort();
	return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Latency percentile over ms samples (p50/p95 over N≥12). */
export function percentile(ms: number[], p: number): number {
	if (ms.length === 0) return 0;
	const s = [...ms].sort((a, b) => a - b);
	const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
	return Math.max(0, s[Math.max(0, i)]);
}

/** Pull the SQL out of a model reply: the first ```sql / ``` fence, else the
 *  first SELECT/WITH run to end-of-text. Trailing fences and `;` stripped. */
export function extractSql(text: string): string {
	const fence = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
	const body = fence ? fence[1] : text;
	const m = body.match(/\b(SELECT|WITH)\b[\s\S]*/i);
	if (!m) return "";
	return m[0]
		.replace(/```[\s\S]*$/, "")
		.replace(/\n\n[\s\S]*$/, "")
		.replace(/;\s*$/, "")
		.trim();
}
