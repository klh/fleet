// hooks/lib/knowledge-query.ts — W1218: the guard core for the knowledge
// query faces (POST /knowledge/query + /knowledge/sql on hooks/bin/
// knowledge-api.ts). Two faces, one guard set:
//   /knowledge/sql   — direct parameterized read-only SQL for agents that
//                      know exactly what they want;
//   /knowledge/query — natural language in, a pinned SQL LLM translates,
//                      the SAME lint executes the result.
// Guardrails on BOTH faces: SELECT/WITH-only single-statement lint, LIMIT
// enforced (appended) or capped (refused past the max), an allowlist of the
// knowledge.db fact tables, and a SQLite readonly connection — a write
// shape dies at the lint with a 4xx; the ro handle is the backstop.
// Auth is buckle-verified (W1141 posture): the caller's bksk_ key goes to
// buckle /v1/admin/keys/verify; the answer's scopes must name the face
// (buckle:knowledge:QUERY_ = /knowledge/query, buckle:knowledge:READ_ =
// /knowledge/sql). Responses carry x-klh-face (W1081 face identity).
import { Database } from "bun:sqlite";

/** The query face's buckle scope (NL question → SQL). QUERY_ implies
 *  nothing: a query key burns LLM tokens, so it is minted deliberately. */
export const KNOWLEDGE_QUERY_SCOPE = "buckle:knowledge:QUERY_";
/** The direct SQL face's buckle scope. */
export const KNOWLEDGE_READ_SCOPE = "buckle:knowledge:READ_";

/** The knowledge.db fact tables the faces may read — everything else
 *  (sqlite_master, the queue/proposal internals) is refused. */
export const KNOWLEDGE_QUERY_TABLES = [
	"knowledge",
	"knowledge_claims",
	"knowledge_fts",
] as const;

/** LIMIT enforcement: appended when the statement has none, and the cap a
 *  statement's own LIMIT may not exceed. */
export const KNOWLEDGE_LIMIT_DEFAULT = 200;
export const KNOWLEDGE_LIMIT_MAX = 1000;

/** Face config — resolved once at boot, env-pinnable for tests. */
export interface KnowledgeQueryConf {
	/** The buckle front /v1/admin/keys/verify rides (loopback on a hub). */
	front: string;
	/** An admin-scoped credential for the verify call. Absent = the faces
	 *  answer 503 (auth backend unavailable) — fail closed. */
	admin: string | null;
	/** OpenAI-wire base of the pinned SQL LLM (e.g. the :4000 router's
	 *  /v1). Absent = /knowledge/query answers 503, /knowledge/sql unaffected. */
	sqlLlmUrl: string | null;
	sqlLlmModel: string;
	sqlLlmKey: string | null;
	/** Per-call budget for the translator (the W1219 pin owns the 2s face
	 *  budget; this is the hard ceiling a slow upstream may not exceed). */
	sqlLlmTimeoutMs: number;
	/** Verify call budget. */
	verifyTimeoutMs: number;
}

const envStr = (v: string | undefined): string | null => {
	const t = (v ?? "").trim();
	return t.length > 0 ? t : null;
};

/** Boot-time resolution (env-first; machine conf carries the real values —
 *  repos carry placeholders only). Empty-string env counts as absent. */
export function knowledgeQueryConf(
	env: NodeJS.ProcessEnv = process.env,
): KnowledgeQueryConf {
	return {
		front:
			envStr(env.SUSPENDERS_KNOWLEDGE_VERIFY_URL) ?? "http://127.0.0.1:4101",
		admin:
			envStr(env.SUSPENDERS_KNOWLEDGE_VERIFY_TOKEN) ??
			envStr(env.BUCKLE_ADMIN_KEY),
		sqlLlmUrl: envStr(env.SUSPENDERS_SQL_LLM_URL),
		sqlLlmModel: envStr(env.SUSPENDERS_SQL_LLM_MODEL) ?? "sql",
		sqlLlmKey: envStr(env.SUSPENDERS_SQL_LLM_KEY),
		sqlLlmTimeoutMs: Number(env.SUSPENDERS_SQL_LLM_TIMEOUT_MS) || 20_000,
		verifyTimeoutMs:
			Number(env.SUSPENDERS_KNOWLEDGE_VERIFY_TIMEOUT_MS) || 3_000,
	};
}

/** The reader schema the translator prompts over — the allowlisted tables,
 *  their columns, and the guardrails a correct translation must respect. */
export const KNOWLEDGE_SCHEMA_TEXT = [
	"Tables (any other table is refused):",
	"- knowledge(id, ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, state, created_at, updated_at, rating, evidence, researched_at)",
	"  One distilled fleet knowledge row. state ∈ ('candidate','active','retired'); active rows are the canon.",
	"- knowledge_claims(id, claim_hash, evidence_id, claim, confidence, version, tombstone, ts, updated_at, origin_machine, scope, tombstone_ts)",
	"  Aggregated cross-machine claims (W1213). tombstone=1 rows are retracted; scope ∈ ('fleet','machine'); version climbs per new claim about the same evidence_id.",
	"- knowledge_fts — FTS5 virtual table over knowledge(topic, fact); query with `MATCH` (e.g. `... WHERE knowledge_fts MATCH 'token'`) for full-text finds.",
].join("\n");

// ─── SQL lexer (the lint's token stream) ────────────────────────────────────

export interface SqlToken {
	/** word = bare identifier/keyword/number; char = single significant
	 *  character; skip = a construct the walker ignores (string literal,
	 *  quoted identifier, comment, parameter token). */
	kind: "word" | "char" | "skip";
	value: string;
}

/** One pass, no regex table: strings ('' escapes), quoted identifiers
 *  ("", [], ``), line/block comments, `?`/`?N`/`:x`/`@x`/`$x` parameter
 *  tokens, bare words, single chars. Unterminated literal/comment = null
 *  (the lint fails the statement closed). */
export function lexSql(sql: string): SqlToken[] | null {
	const out: SqlToken[] = [];
	const n = sql.length;
	let i = 0;
	while (i < n) {
		const c = sql[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
		else if (c === "-" && sql[i + 1] === "-") {
			while (i < n && sql[i] !== "\n") i++;
		} else if (c === "/" && sql[i + 1] === "*") {
			const end = sql.indexOf("*/", i + 2);
			if (end === -1) return null;
			i = end + 2;
		} else if (c === "'" || c === '"' || c === "`" || c === "[") {
			const close = c === "[" ? "]" : c;
			let k = -1;
			let j = i + 1;
			for (;;) {
				k = sql.indexOf(close, j);
				if (k === -1) return null;
				if (sql[k + 1] === close) {
					j = k + 2;
					continue;
				}
				break;
			}
			out.push({ kind: "skip", value: c === "'" ? "string" : "ident" });
			i = k + 1;
		} else if (c === "?" || c === ":" || c === "@" || c === "$") {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_]/.test(sql[j] ?? "")) j++;
			if (j === i + 1 && c === "$") {
				out.push({ kind: "char", value: c });
				i++;
			} else {
				out.push({ kind: "skip", value: sql.slice(i, j) });
				i = j;
			}
		} else if (/[A-Za-z0-9_$]/.test(c)) {
			let j = i;
			while (j < n && /[A-Za-z0-9_$]/.test(sql[j] ?? "")) j++;
			out.push({ kind: "word", value: sql.slice(i, j) });
			i = j;
		} else {
			out.push({ kind: "char", value: c });
			i++;
		}
	}
	return out;
}

// ─── the read-only lint ─────────────────────────────────────────────────────

/** Refused vocabulary: every SQLite write/DDL/txn verb, plus load_extension
 *  (the one read-shaped function with a side effect). Strings/quoted
 *  identifiers/comments are skip tokens — `WHERE fact LIKE '%update%'`
 *  never trips this. */
const FORBIDDEN_WORDS = new Set([
	"insert",
	"update",
	"delete",
	"replace",
	"drop",
	"alter",
	"create",
	"attach",
	"detach",
	"pragma",
	"vacuum",
	"reindex",
	"analyze",
	"begin",
	"commit",
	"rollback",
	"savepoint",
	"release",
	"load_extension",
]);

export interface SqlLint {
	ok: boolean;
	status: number;
	/** the normalized statement (trimmed, trailing semicolons stripped) */
	sql: string;
	/** every table reference the statement resolves to */
	tables: string[];
	error?: string;
	/** the statement's own top-level LIMIT bound, when it carries one that
	 *  passed the plain-integer check; null = none (the caller's limit wins) */
	ownLimit: number | null;
}

/** The face lint: one SELECT/WITH statement, read-only shape, allowlisted
 *  tables. Fails closed on anything it cannot fully tokenize. */
export function lintReadOnlySql(raw: string): SqlLint {
	const empty = (error: string): SqlLint => ({
		ok: false,
		status: 400,
		sql: raw,
		tables: [],
		error,
		ownLimit: null,
	});
	const sql = raw
		.trim()
		.replace(/[\s;]+$/u, "")
		.trim();
	if (!sql) return empty("sql required");
	const tokens = lexSql(sql);
	if (tokens === null) return empty("unterminated literal or comment");
	if (tokens.length === 0) return empty("sql required");
	for (const t of tokens) {
		if (t.kind === "char" && t.value === ";")
			return empty("single statement only");
	}
	const first = tokens[0];
	if (
		first?.kind !== "word" ||
		!["select", "with"].includes(first.value.toLowerCase())
	)
		return empty("SELECT or WITH statements only");
	const lowered = new Set(
		tokens.filter((t) => t.kind === "word").map((t) => t.value.toLowerCase()),
	);
	for (const w of FORBIDDEN_WORDS)
		if (lowered.has(w))
			return empty(`refused: ${w} is not a read-only statement`);
	const named = tokens.find(
		(t) => t.kind === "skip" && /^[:@$]/u.test(t.value),
	);
	if (named)
		return empty(
			"named parameters are refused (positional ? only — the silent-null trap)",
		);
	return scanTablesAndLimit(tokens, sql);
}

/** The FROM/JOIN-target walk: every table the statement actually reads,
 *  CTE names excluded (a WITH alias is not a table), LIMIT analysis.
 *  `FROM a, b` re-arms after the comma; `FROM (` opens a subquery (its
 *  internals walk like everything else); a schema-qualified ref, an
 *  unknown table-valued function, or an expression LIMIT refuses — fail
 *  closed. Nested WITH inside a CTE body clobbers the outer list state,
 *  so a comma after THAT outer list refuses as an unknown table — exotic,
 *  and refusal is the safe direction. */
function scanTablesAndLimit(tokens: SqlToken[], sql: string): SqlLint {
	const refuse = (error: string): SqlLint => ({
		ok: false,
		status: 400,
		sql,
		tables: [],
		error,
		ownLimit: null,
	});
	const tables: string[] = [];
	const cteNames = new Set<string>();
	let depth = 0;
	let pendingTable = false;
	let withDepth = -1;
	let expectCte = false;
	let cteListLive = false;
	let fromArmed = false;
	let fromDepth = 0;
	let limitIdx = -1;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) break;
		if (t.kind === "char") {
			if (t.value === "(") depth++;
			else if (t.value === ")") {
				depth--;
				if (depth < 0) return refuse("unbalanced parentheses");
			} else if (t.value === "," && fromArmed && depth === fromDepth)
				pendingTable = true;
			continue;
		}
		if (t.kind !== "word") continue;
		const w = t.value.toLowerCase();
		if (expectCte) {
			if (w !== "recursive") {
				cteNames.add(w);
				expectCte = false;
				cteListLive = true;
			}
			continue;
		}
		if (w === "with") {
			withDepth = depth;
			expectCte = true;
			cteListLive = false;
			fromArmed = false;
			continue;
		}
		if (cteListLive && withDepth === depth) {
			withDepth = -1;
			cteListLive = false;
		}
		if (w === "from" || w === "join") {
			const next = tokens[i + 1];
			if (next?.kind === "char" && next.value === "(") {
				fromArmed = true;
				fromDepth = depth;
			} else pendingTable = true;
			continue;
		}
		if (pendingTable) {
			const next = tokens[i + 1];
			if (next?.kind === "char" && next.value === ".")
				return refuse("schema-qualified table references are refused");
			if (!cteNames.has(w)) {
				if (!tableAllowlisted(w))
					return refuse(`table ${w} is not allowlisted`);
				tables.push(w);
			}
			pendingTable = false;
			fromArmed = true;
			fromDepth = depth;
			continue;
		}
		if (fromArmed && depth === fromDepth && FROM_ENDERS.includes(w))
			fromArmed = false;
		if (w === "limit" && depth === 0 && limitIdx === -1) limitIdx = i;
	}
	if (depth !== 0) return refuse("unbalanced parentheses");
	if (limitIdx === -1)
		return { ok: true, status: 200, sql, tables, ownLimit: null };
	return checkLimitClause(tokens, limitIdx, sql, tables);
}

const FROM_ENDERS = [
	"where",
	"group",
	"having",
	"order",
	"limit",
	"window",
	"union",
	"except",
	"intersect",
	"on",
	"using",
];

const tableAllowlisted = (w: string): boolean =>
	(KNOWLEDGE_QUERY_TABLES as readonly string[]).includes(w);

/** A top-level LIMIT must be plain integer literals — expression or
 *  parameter forms refuse (they can express "no limit"). Comma form:
 *  `LIMIT offset, count`; the count is the cap-checked bound. */
function checkLimitClause(
	tokens: SqlToken[],
	limitIdx: number,
	sql: string,
	tables: string[],
): SqlLint {
	const refuse = (error: string): SqlLint => ({
		ok: false,
		status: 400,
		sql,
		tables,
		error,
		ownLimit: null,
	});
	const intAt = (idx: number): number | null => {
		const t = tokens[idx];
		if (t?.kind !== "word" || !/^\d+$/u.test(t.value)) return null;
		return Number(t.value);
	};
	const n1 = intAt(limitIdx + 1);
	if (n1 === null)
		return refuse(
			"LIMIT must be a plain integer literal (use the limit parameter instead)",
		);
	const cap = (bound: number): SqlLint =>
		bound > KNOWLEDGE_LIMIT_MAX
			? refuse(`LIMIT ${bound} exceeds the cap (${KNOWLEDGE_LIMIT_MAX})`)
			: { ok: true, status: 200, sql, tables, ownLimit: bound };
	const noSuffix = (): SqlLint =>
		refuse("LIMIT must be a plain integer literal (no expression suffix)");
	const after = tokens[limitIdx + 2];
	if (after?.kind === "char" && after.value === ",") {
		const count = intAt(limitIdx + 3);
		if (count === null)
			return refuse("LIMIT offset, count must be plain integer literals");
		if (tokens[limitIdx + 4] !== undefined) return noSuffix();
		return cap(count);
	}
	if (after?.kind === "word" && after.value.toLowerCase() === "offset") {
		if (intAt(limitIdx + 3) === null)
			return refuse("OFFSET must be a plain integer literal");
		if (tokens[limitIdx + 4] !== undefined) return noSuffix();
		return cap(n1);
	}
	if (after !== undefined) return noSuffix();
	return cap(n1);
}

// ─── the readonly executor ──────────────────────────────────────────────────

export interface KnowledgeSqlOutcome {
	ok: boolean;
	/** the HTTP status the caller should answer with */
	status: number;
	/** the statement as provided (normalized) */
	sql: string;
	error?: string;
	/** the executed form — LIMIT appended when the statement carried none */
	executedSql?: string;
	rows?: Record<string, unknown>[];
	rowCount?: number;
	/** the bound actually applied */
	limit?: number;
	elapsedMs?: number;
}

/** Open the face's dedicated readonly handle — mode=ro is the engine-level
 *  backstop behind the lint (a write shape never reaches it, and even a
 *  lint miss cannot write through this connection). Same-process WAL
 *  readers work because the sink holds the RW handle. */
export function openKnowledgeQueryDb(path: string): Database {
	return new Database(path, { readonly: true, create: false });
}

/** Lint → LIMIT-resolve → execute on the readonly handle. Positional `?`
 *  parameters only (bun:sqlite named binding silently nulls on unprefixed
 *  keys — the silent-null trap justifies refusing named forms at the face).
 *  Execution errors (bad column, bad params) answer 400 with the reason. */
export function executeKnowledgeSql(
	db: Database,
	raw: string,
	opts: { limit?: unknown; params?: unknown[] } = {},
): KnowledgeSqlOutcome {
	const t0 = performance.now();
	const lint = lintReadOnlySql(raw);
	if (!lint.ok)
		return { ok: false, status: lint.status, sql: raw, error: lint.error };
	let limit = Number(opts.limit ?? KNOWLEDGE_LIMIT_DEFAULT);
	if (!Number.isFinite(limit) || limit <= 0) limit = KNOWLEDGE_LIMIT_DEFAULT;
	limit = Math.min(Math.floor(limit), KNOWLEDGE_LIMIT_MAX);
	let finalSql = lint.sql;
	if (lint.ownLimit === null) finalSql = `${lint.sql}\nLIMIT ${limit}`;
	else limit = lint.ownLimit;
	try {
		const stmt = db.query(finalSql);
		return finishExecution(
			stmt.all(...(opts.params ?? [])),
			finalSql,
			limit,
			t0,
			lint,
		);
	} catch (e) {
		return {
			ok: false,
			status: 400,
			sql: lint.sql,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

function finishExecution(
	rows: unknown,
	finalSql: string,
	limit: number,
	t0: number,
	lint: SqlLint,
): KnowledgeSqlOutcome {
	const list = rows as Record<string, unknown>[];
	return {
		ok: true,
		status: 200,
		sql: lint.sql,
		executedSql: finalSql,
		rows: list,
		rowCount: list.length,
		limit,
		elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
	};
}

// ─── buckle-verified auth (W1141 posture) ───────────────────────────────────

export interface KeyVerdict {
	ok: boolean;
	/** 401 invalid key · 403 wrong scope · 503 auth backend unreachable */
	status: number;
	code?: string;
	keyId: string | null;
	scopes: string[];
	/** the face scope the caller must hold */
	needed: string;
}

/** Verify a presented bksk_ key at the buckle gate's own verify API and
 *  scope-check it for one face. No anonymous surface: no key, non-bksk_
 *  key, or invalid key = 401; a valid key without the face's scope = 403;
 *  a verify leg that cannot answer = 503 (fail closed). Revocation is
 *  immediate — every request verifies, nothing is cached. */
export async function verifyKnowledgeKey(
	key: string | null,
	needed: string,
	o: {
		front: string;
		admin: string | null;
		fetchFn?: typeof fetch;
		timeoutMs?: number;
	},
): Promise<KeyVerdict> {
	const refused = (status: number, code: string): KeyVerdict => ({
		ok: false,
		status,
		code,
		keyId: null,
		scopes: [],
		needed,
	});
	if (!key?.startsWith("bksk_")) return refused(401, "knowledge.auth_missing");
	if (!o.admin) return refused(503, "knowledge.verify_unconfigured");
	const fetchFn = o.fetchFn ?? fetch;
	try {
		const r = await fetchFn(`${o.front}/v1/admin/keys/verify`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${o.admin}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ key }),
			signal: AbortSignal.timeout(o.timeoutMs ?? 3_000),
		});
		if (!r.ok) return refused(503, `knowledge.verify_backend_${r.status}`);
		const v = (await r.json().catch(() => null)) as {
			valid?: boolean;
			code?: string;
			key_id?: string;
			scopes?: string[];
		} | null;
		if (v?.valid !== true)
			return refused(401, v?.code ?? "knowledge.key_invalid");
		return finishVerify(v.scopes ?? [], needed, v.key_id ?? null, refused);
	} catch {
		// partition/timeout mid-verify: fail closed
		return refused(503, "knowledge.verify_unreachable");
	}
}

function finishVerify(
	scopes: string[],
	needed: string,
	keyId: string | null,
	refused: (status: number, code: string) => KeyVerdict,
): KeyVerdict {
	if (!scopes.includes(needed))
		return refused(403, "knowledge.insufficient_scope");
	return { ok: true, status: 200, keyId, scopes, needed };
}

/** The translator's system prompt: the guardrail contract the model must
 *  translate within. The SAME lint re-checks the result — the prompt is
 *  guidance, the lint is the law. */
export const TRANSLATOR_SYSTEM = [
	"Translate the user's question into ONE read-only SQLite SELECT statement.",
	"Output ONLY the SQL — no prose, no code fences.",
	"SELECT or WITH only; never INSERT/UPDATE/DELETE/REPLACE/ATTACH/PRAGMA/DDL.",
	KNOWLEDGE_SCHEMA_TEXT,
	"Prefer knowledge_fts MATCH for keyword lookups; LIKE '%…%' for substrings.",
	"A LIMIT must be a plain integer literal ≤ 1000.",
].join("\n");

/** ```sql fence → generic fence → whole trimmed text. */
export const extractSql = (text: string): string => {
	const m = /```(?:sql)?\s*([\s\S]*?)```/u.exec(text);
	const inner = m?.[1]?.trim();
	if (inner) return inner;
	return text.trim();
};

export interface TranslatorOutcome {
	ok: boolean;
	/** the LLM's raw text — diagnostics after a refusal */
	text?: string;
	/** the extracted statement */
	sql?: string;
	/** the lint verdict on the extracted statement */
	lint?: SqlLint;
	error?: string;
	elapsedMs?: number;
}

/** One question in, one lint-passing statement out: the pinned SQL LLM
 *  (W1219 owns the pin — any OpenAI-wire endpoint serves) translates,
 *  extractSql pulls the statement, and the SAME lint re-checks it. */
export async function translateQuestion(
	question: string,
	conf: Pick<
		KnowledgeQueryConf,
		"sqlLlmUrl" | "sqlLlmModel" | "sqlLlmKey" | "sqlLlmTimeoutMs"
	>,
	fetchFn: typeof fetch = fetch,
): Promise<TranslatorOutcome> {
	const t0 = performance.now();
	const q = question.trim();
	const out = (
		status: number,
		extra: Omit<Partial<TranslatorOutcome>, "elapsedMs"> = {},
	): TranslatorOutcome => ({
		ok: status === 200,
		status,
		elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
		...extra,
	});
	if (!q) return out(400, { error: "question required" });
	if (!conf.sqlLlmUrl)
		return out(503, { error: "knowledge.query_unconfigured" });
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (conf.sqlLlmKey) headers.authorization = `Bearer ${conf.sqlLlmKey}`;
	try {
		const r = await fetchFn(`${conf.sqlLlmUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: conf.sqlLlmModel,
				temperature: 0,
				messages: [
					{ role: "system", content: TRANSLATOR_SYSTEM },
					{ role: "user", content: q },
				],
			}),
			signal: AbortSignal.timeout(conf.sqlLlmTimeoutMs),
		});
		if (!r.ok) return out(503, { error: `knowledge.llm_backend_${r.status}` });
		const data = (await r.json().catch(() => null)) as {
			choices?: { message?: { content?: unknown } }[];
		} | null;
		const text = data?.choices?.[0]?.message?.content;
		if (typeof text !== "string" || !text.trim())
			return out(503, { error: "knowledge.llm_malformed" });
		return finishTranslation(text, out);
	} catch {
		// partition/timeout mid-translate: fail closed
		return out(503, { error: "knowledge.llm_unreachable" });
	}
}

/** Fence extraction (```sql → ``` → whole text) + the SAME lint. A refused
 *  translation is 422 — the model's output failed, not the caller's request. */
const finishTranslation = (
	text: string,
	out: (
		status: number,
		extra?: Partial<TranslatorOutcome>,
	) => TranslatorOutcome,
): TranslatorOutcome => {
	const sql = extractSql(text);
	const lint = lintReadOnlySql(sql);
	if (!lint.ok) return out(422, { text, sql, lint, error: lint.error });
	return out(200, { text, sql, lint });
};

/** The /knowledge/query face composition: translate → execute the
 *  lint-passing statement on the readonly handle. The response carries rows
 *  + the SQL that produced them + the combined wall time. */
export async function answerKnowledgeQuestion(
	db: Database,
	question: string,
	conf: KnowledgeQueryConf,
	opts: { limit?: unknown; fetchFn?: typeof fetch } = {},
): Promise<KnowledgeSqlOutcome> {
	const t = await translateQuestion(question, conf, opts.fetchFn);
	if (!t.ok)
		return { ok: false, status: t.status, sql: t.sql ?? "", error: t.error };
	const ex = executeKnowledgeSql(db, t.sql ?? "", { limit: opts.limit });
	if (!ex.ok) return ex;
	return {
		...ex,
		elapsedMs:
			Math.round(((t.elapsedMs ?? 0) + (ex.elapsedMs ?? 0)) * 100) / 100,
	};
}
