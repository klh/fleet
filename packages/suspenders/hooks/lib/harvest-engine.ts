// hooks/lib/harvest-engine.ts — ONE transcript-tail harvest engine (W652.3).
// Discovery + byte-cursor + tail-read + complete-line framing shared by every
// ~/.claude/projects journal miner (W127 usage, W243 activity). Miners keep
// their per-file corner semantics (empty-tail cursor policy, per-line parse)
// and their own tx scope; the engine never writes cursors itself. Cursors are
// BYTE offsets (Buffer.byteLength) — W243's string-index math silently
// under-advanced on multibyte transcripts; this engine is the one fix.
// The board TTL gate (facts <ns>.harvestAt + module reentrancy) was the same
// shape in both miners — gatedHarvest() is its single source.
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { readBoardSettings } from "./board-config.ts";
import {
	cursorKey,
	loadCursor,
	readTail,
	type TpCursor,
} from "./transcript-cursor.ts";

export interface TailStats {
	files: number; // transcripts seen
	harvested: number; // transcripts whose tail was read
	skipped: number; // unchanged (cursor hit) — the idempotency fast path
}

export type TailScan =
	| { kind: "skip" } // unchanged transcript — the idempotency fast path
	| {
			kind: "empty"; // tail holds no complete line — cursor policy is caller's
			abs: string;
			key: string;
			start: number;
			mtimeMs: number;
	  }
	| {
			kind: "lines";
			abs: string;
			rel: string;
			sid: string; // transcript basename minus .jsonl (sessions.sid join key)
			key: string;
			cur: TpCursor | null; // prior cursor, post truncation reset
			start: number; // first unharvested byte
			next: number; // byte offset past the last complete line — save this
			mtimeMs: number;
			lines: { text: string; offset: number }[]; // offset = byte of line start
	  };

export interface TailOpts {
	/** cursor key namespace — cursorKey(prefix, abs), e.g. "usage.tp" */
	prefix: string;
	/** transcript root; default ~/.claude/projects */
	root?: string;
	/** never-opened files with mtime older than this many days are ignored */
	windowDays?: number;
	/** fires after cursor load, before skip/truncation — legacy-cursor refusal */
	guard?: (scan: { abs: string; key: string; cur: TpCursor | null }) => void;
}

/** One sorted pass over the transcript root. Streaming per file; cursors and
 *  rollup writes stay with the caller (usage writes inside its tx). */
export function scanTranscriptTails(
	db: Database,
	opts: TailOpts,
	onScan: (scan: TailScan) => void,
): TailStats {
	const root = opts.root ?? `${process.env.HOME}/.claude/projects`;
	const cutoff =
		opts.windowDays === undefined
			? null
			: (opts.nowMs ?? Date.now()) - opts.windowDays * 86_400_000;
	const out: TailStats = { files: 0, harvested: 0, skipped: 0 };
	const glob = new Bun.Glob("**/*.jsonl");
	for (const rel of [...glob.scanSync({ cwd: root, onlyFiles: true })].sort()) {
		out.files++;
		const abs = join(root, rel);
		let size: number;
		let mtimeMs: number;
		try {
			const s = statSync(abs);
			size = s.size;
			mtimeMs = s.mtimeMs;
		} catch {
			continue; // vanished mid-scan — next harvest catches the remainder
		}
		const key = cursorKey(opts.prefix, abs);
		let cur = loadCursor(db, key);
		opts.guard?.({ abs, key, cur });
		if (cur && size < cur.o) cur = null; // truncated → full re-read (rare)
		if (!cur && cutoff !== null && mtimeMs < cutoff) continue; // stale + never opened → out of window
		if (cur && size === cur.o && mtimeMs === cur.m) {
			out.skipped++;
			onScan({ kind: "skip" });
			continue; // unchanged transcript: the idempotency fast path
		}
		const start = cur?.o ?? 0;
		const text = readTail(abs, start);
		const nl = text.lastIndexOf("\n");
		if (nl === -1) {
			onScan({ kind: "empty", abs, key, start, mtimeMs });
			continue; // no complete line in the tail — retry next pass
		}
		const body = text.slice(0, nl + 1);
		const next = start + Buffer.byteLength(body);
		const lines = body.split("\n");
		lines.pop(); // trailing "" after the final newline
		const framed: { text: string; offset: number }[] = [];
		let at = start;
		for (const line of lines) {
			framed.push({ text: line, offset: at });
			at += Buffer.byteLength(line) + 1;
		}
		onScan({
			kind: "lines",
			abs,
			rel,
			sid: basename(rel).replace(/\.jsonl$/, ""),
			key,
			cur,
			start,
			next,
			mtimeMs,
			lines: framed,
		});
		out.harvested++;
	}
	return out;
}

/** sessions.sid → actor — the attribution map every miner rebuilds. */
export function sessionActorMap(
	db: Database,
): Map<string, { actor: string | null }> {
	const m = new Map<string, { actor: string | null }>();
	for (const r of db
		.query("SELECT sid, actor FROM sessions WHERE actor IS NOT NULL")
		.all() as { sid: string; actor: string | null }[])
		m.set(r.sid, { actor: r.actor });
	return m;
}

/** Token fields arrive as JSON numbers-or-garbage — coerce honestly to 0. */
export const num = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

// ─── board TTL gate: harvest at most once per TTL, never a daemon ─────────
// W147: the default TTL rides the console settings file (~/.claude/local-llm/
// suspenders-board.json harvest_ttl_s) — config-over-code, 300s when unset.
const inFlight = new Set<string>();

export const defaultTtlMs = (): number => {
	const s = readBoardSettings().settings.harvest_ttl_s;
	return s && s >= 1 ? s * 1000 : 5 * 60_000;
};

/** TTL-gated run: `<ns>.harvestAt` freshness in facts + per-ns reentrancy
 *  fold; failures log soft and return null. Returns null when gated out. */
export function gatedHarvest<T>(
	db: Database,
	ns: string,
	source: string,
	run: () => T,
	ttlMs = defaultTtlMs(),
): T | null {
	const row = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`${ns}.harvestAt`) as { value: string | null } | null;
	const at = Number(row?.value ?? 0);
	if (
		inFlight.has(ns) ||
		(Number.isFinite(at) && at > 0 && Date.now() - at < ttlMs)
	)
		return null;
	inFlight.add(ns);
	try {
		const s = run();
		db.query(
			"INSERT INTO facts (key, value, source, ts) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
		).run(`${ns}.harvestAt`, String(Date.now()), source, Date.now());
		return s;
	} catch (e) {
		console.error(
			`[${source}] failed soft: ${e instanceof Error ? e.message : e}`,
		);
		return null;
	} finally {
		inFlight.delete(ns);
	}
}
