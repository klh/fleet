// src/pipeline.ts — W5 prompt pipeline IN: inbound compression. Lane
// results/summaries shown to the owner get a condensed variant computed
// SIDE-BAND (the served bytes stay byte-identical — the wire contract is
// never mutated); the raw output stays one GET away by rid. W304.3: the
// ruleset is the blam canonical engine, tier `politeness` (spec
// packages/blam/docs/prompt-condense-spec.md, migration step 3 — one
// engine everywhere; audience split: outbound sideband = politeness).
// Deterministic, meaning-preserving: the protect grammar (fences, inline
// code, paths, URLs, flags…) survives byte-for-byte; hedges survive (law
// L2). The inline line-anchored ruleset is retired — courtesy-closer
// drops ("Let me know…", "Hope this helps!") are NOT in the politeness
// tier's rule table and now survive; sanctioned by the one-engine law.
import { Database } from "bun:sqlite";
import { condenseTier } from "blam/src/condense/tiers.ts";
import { CONDENSE_VERSION } from "blam/src/condense/version.ts";

export { CONDENSE_VERSION };

// ─── the pass ──────────────────────────────────────────────────────────────

export interface CondenseResult {
	/** The condensed text (=== input when no rule fired). */
	text: string;
	/** The rules that fired, in order. Empty = nothing changed. */
	rules: string[];
}

/** The politeness-only inbound pass — DELEGATED (W304.3) to the blam
 *  canonical engine, tier `politeness` (the audience split: users read
 *  what comes back). Protected surface survives byte-for-byte (law L1),
 *  hedges survive (law L2). The engine audit names (`filler:*`,
 *  `tidy:*`) differ from the retired inline `drop:`/`prefix:` families —
 *  each fired rule is prefixed `blam:` in the rules list. */
export function condenseText(raw: string): CondenseResult {
	const { text, rules } = condenseTier("politeness", raw);
	return { text, rules: rules.map((name) => `blam:${name}`) };
}

// ─── the dialect text extractor ─────────────────────────────────────────────

/** Assistant text out of a non-streaming chat response (the inbound face).
 *  Anything this can't honestly extract → null (metered skip). */
export function extractText(
	dialect: "openai" | "anthropic",
	parsed: unknown,
): string | null {
	if (parsed === null || typeof parsed !== "object") return null;
	const p = parsed as Record<string, unknown>;
	if (dialect === "anthropic") {
		const content = p.content;
		if (!Array.isArray(content)) return null;
		const text = content
			.filter(
				(b): b is { type: "text"; text: string } =>
					typeof b === "object" &&
					b !== null &&
					(b as { type?: string }).type === "text" &&
					typeof (b as { text?: string }).text === "string",
			)
			.map((b) => b.text)
			.join("\n");
		return text.length > 0 ? text : null;
	}
	const choices = p.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const msg = (choices[0] as { message?: { content?: unknown } }).message;
	const content = msg?.content;
	if (typeof content === "string" && content.length > 0) return content;
	return null;
}

// ─── the sidestore ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_in (
  rid TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  dialect TEXT NOT NULL,
  condensed TEXT NOT NULL,
  raw TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '[]',
  raw_bytes INTEGER NOT NULL,
  condensed_bytes INTEGER NOT NULL,
  condense_version TEXT
);
`;

const MAX_ROWS = 500;

/** The raw stays one GET away: rid-keyed rows in the shared buckle db (own
 *  WAL connection — the Ledger/AidsLedger precedent). Bounded at 500 rows
 *  (newest win); raw+condensed both live here, nothing is lost. */
export class CondenseStore {
	private readonly db: Database;

	constructor(
		path: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		// Pre-W304.3 databases lack the condense_version column; CREATE TABLE
		// IF NOT EXISTS never amends an existing table (aids.ts precedent).
		try {
			this.db.exec("ALTER TABLE pipeline_in ADD COLUMN condense_version TEXT");
		} catch {
			// column already present (fresh schema or migrated)
		}
	}

	put(input: {
		rid: string;
		dialect: string;
		condensed: string;
		raw: string;
		rules: string[];
		/** Engine version that produced `condensed`; defaults to this
		 *  build's CONDENSE_VERSION (write-time honest). */
		condense_version?: string;
	}): void {
		this.db
			.query(
				`INSERT INTO pipeline_in
         (rid, ts, dialect, condensed, raw, rules, raw_bytes, condensed_bytes, condense_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rid) DO UPDATE SET
         ts = excluded.ts, condensed = excluded.condensed, raw = excluded.raw,
         rules = excluded.rules, raw_bytes = excluded.raw_bytes,
         condensed_bytes = excluded.condensed_bytes,
         condense_version = excluded.condense_version`,
			)
			.run(
				input.rid,
				this.now().getTime(),
				input.dialect,
				input.condensed,
				input.raw,
				JSON.stringify(input.rules),
				Buffer.byteLength(input.raw),
				Buffer.byteLength(input.condensed),
				input.condense_version ?? CONDENSE_VERSION,
			);
		// bounded: newest 500 rows win
		this.db
			.query(
				`DELETE FROM pipeline_in WHERE rid NOT IN (
           SELECT rid FROM pipeline_in ORDER BY ts DESC, rid DESC LIMIT ?
         )`,
			)
			.run(MAX_ROWS);
	}

	get(rid: string): {
		rid: string;
		ts: number;
		dialect: string;
		condensed: string;
		raw: string;
		rules: string[];
		raw_bytes: number;
		condensed_bytes: number;
		/** blam-condense/x that produced `condensed`; null = pre-engine row. */
		condense_version: string | null;
	} | null {
		const row = this.db
			.query(
				"SELECT rid, ts, dialect, condensed, raw, rules, raw_bytes, condensed_bytes, condense_version FROM pipeline_in WHERE rid = ?",
			)
			.get(rid) as {
			rid: string;
			ts: number;
			dialect: string;
			condensed: string;
			raw: string;
			rules: string;
			raw_bytes: number;
			condensed_bytes: number;
			condense_version: string | null;
		} | null;
		if (!row) return null;
		return { ...row, rules: JSON.parse(row.rules) as string[] };
	}

	/** Newest rows first (the board's "recent" list). */
	list(limit = 25): Array<{
		rid: string;
		ts: number;
		dialect: string;
		raw_bytes: number;
		condensed_bytes: number;
	}> {
		return this.db
			.query(
				"SELECT rid, ts, dialect, raw_bytes, condensed_bytes FROM pipeline_in ORDER BY ts DESC, rid DESC LIMIT ?",
			)
			.all(Math.min(Math.max(1, limit), 100)) as Array<{
			rid: string;
			ts: number;
			dialect: string;
			raw_bytes: number;
			condensed_bytes: number;
		}>;
	}

	close(): void {
		this.db.close();
	}
}

// ─── the routes ─────────────────────────────────────────────────────────────

/** GET /pipeline/in/<rid> → {condensed, raw, …} (raw one click away).
 *  GET /pipeline/in?limit=N → newest summaries (the board's list face).
 *  Bare deps (no pipeline store) 404 honestly — the AppDeps contract. */
export async function pipelineRoutes(
	deps: {
		pipeline?: CondenseStore;
	},
	req: Request,
	path: string,
): Promise<Response | null> {
	if (!path.startsWith("/pipeline/in")) return null;
	if (!deps.pipeline) return problem404(`no route: ${req.method} ${path}`);
	if (path === "/pipeline/in" && req.method === "GET") {
		const limit = Number(new URL(req.url).searchParams.get("limit") ?? "25");
		return Response.json({ ok: true, rows: deps.pipeline.list(limit) });
	}
	const rid = path.slice("/pipeline/in/".length);
	if (rid.length > 0 && req.method === "GET") {
		const row = deps.pipeline.get(rid);
		if (!row) return problem404(`no condense row for rid ${rid}`);
		return Response.json({ ok: true, ...row });
	}
	return null;
}

function problem404(why: string): Response {
	return Response.json(
		{
			type: "/problems/not_found",
			title: "Not Found",
			status: 404,
			detail: why,
			code: "buckle.no_route",
		},
		{ status: 404, headers: { "content-type": "application/problem+json" } },
	);
}
