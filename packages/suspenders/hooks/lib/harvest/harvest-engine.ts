// hooks/lib/harvest/harvest-engine.ts — ONE transcript-tail harvest engine (W652.3,
// W657 pipeline). Discovery + byte-cursor + tail-read + complete-line framing
// shared by every ~/.claude/projects journal miner (W127 usage, W243
// activity). Miners keep their per-file corner semantics (empty-tail cursor
// policy, per-line parse) and their own tx scope; the engine never writes
// cursors itself. Cursors are BYTE offsets (Buffer.byteLength) — W243's
// string-index math silently under-advanced on multibyte transcripts; this
// engine is the one fix.
// The board TTL gate (facts <ns>.harvestAt + module reentrancy) was the same
// shape in both miners — gatedHarvest() is its single source.
// W657: scanTranscriptTails fans one read pass to N cursor slots
// (prefixes/guards/windows), and runHarvestPipeline() is the ONE pipeline —
// source adapters + shared store path (cursor saves stay adapter-owned, one
// BEGIN IMMEDIATE spans the pass) + the gatedHarvest scheduling contract.
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { readBoardSettings } from "../board/board-config.ts";
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
			slot: number; // cursor-namespace index (multi-adapter fan-out)
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
			slot: number; // cursor-namespace index (multi-adapter fan-out)
	  };

/** legacy-cursor refusal hook — fires after cursor load, before skip/decay */
export type TailGuard = (scan: {
	abs: string;
	key: string;
	cur: TpCursor | null;
}) => void;

export interface TailOpts {
	/** cursor key namespace — cursorKey(prefix, abs), e.g. "usage.tp" */
	prefix?: string;
	/** multi-adapter fan-out: ONE read pass, one cursor namespace per slot */
	prefixes?: string[];
	/** legacy-cursor refusal; per-slot form rides `prefixes` */
	guard?: TailGuard;
	guards?: (TailGuard | undefined)[];
	/** never-opened files with mtime older than this many days are ignored */
	windowDays?: number;
	/** per-slot recency windows (parallel to `prefixes`) */
	windows?: (number | undefined)[];
	/** transcript root; default ~/.claude/projects */
	root?: string;
	/** clock override for the recency windows */
	nowMs?: number;
}

/** One sorted pass over the transcript root. Streaming per file; cursors and
 *  rollup writes stay with the caller (usage writes inside its tx). With
 *  `prefixes`, the file is stat'ed and read once and every slot gets its own
 *  verdict — skip/empty/lines are per-slot cursor decisions. */
export function scanTranscriptTails(
	db: Database,
	opts: TailOpts,
	onScan: (scan: TailScan) => void,
): TailStats {
	const root = opts.root ?? `${process.env.HOME}/.claude/projects`;
	const slots = opts.prefixes ?? [opts.prefix ?? ""];
	const guards = opts.guards ?? (opts.guard ? slots.map(() => opts.guard) : []);
	const windows = opts.windows ?? slots.map(() => opts.windowDays);
	const now = opts.nowMs ?? Date.now();
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
		// per-slot cursor state; each slot decides skip/need independently.
		// A windowed-out slot stays silent (no verdict, no cursor touch) even
		// when another slot reads the file — its window policy says ignore.
		interface SlotState {
			slot: number;
			key: string;
			cur: TpCursor | null;
			start: number;
		}
		const active: SlotState[] = [];
		for (let i = 0; i < slots.length; i++) {
			const key = cursorKey(slots[i], abs);
			let cur = loadCursor(db, key);
			guards[i]?.({ abs, key, cur });
			if (cur && size < cur.o) cur = null; // truncated → full re-read (rare)
			const win = windows[i];
			const cutoff = win === undefined ? null : now - win * 86_400_000;
			if (!cur && cutoff !== null && mtimeMs < cutoff) continue; // stale + never opened → out of window
			if (cur && size === cur.o && mtimeMs === cur.m) {
				out.skipped++;
				onScan({ kind: "skip", slot: i });
				continue; // unchanged transcript: the idempotency fast path
			}
			active.push({ slot: i, key, cur, start: cur?.o ?? 0 });
		}
		if (!active.length) continue;
		const minStart = Math.min(...active.map((s) => s.start));
		const text = readTail(abs, minStart);
		const nl = text.lastIndexOf("\n");
		if (nl === -1) {
			for (const s of active)
				onScan({
					kind: "empty",
					abs,
					key: s.key,
					start: s.start,
					mtimeMs,
					slot: s.slot,
				});
			continue; // no complete line in the tail — retry next pass
		}
		const body = text.slice(0, nl + 1);
		const lines = body.split("\n");
		lines.pop(); // trailing "" after the final newline
		const framed: { text: string; offset: number }[] = [];
		let at = minStart;
		for (const line of lines) {
			framed.push({ text: line, offset: at });
			at += Buffer.byteLength(line) + 1;
		}
		for (const s of active) {
			// this slot's subset: lines fully at/after its own start. A line
			// straddling the start hands over the same mid-line fragment a
			// slot-private tail read would have produced; a line that ended
			// before it maps to the empty first fragment ("" — parse-fails in
			// every miner) and is dropped.
			const subset: { text: string; offset: number }[] = [];
			for (const ln of framed) {
				const end = ln.offset + Buffer.byteLength(ln.text);
				if (ln.offset < s.start) {
					if (end > s.start)
						subset.push({
							text: ln.text.slice(s.start - ln.offset),
							offset: s.start,
						});
					continue;
				}
				subset.push(ln);
			}
			if (!subset.length) {
				onScan({
					kind: "empty",
					abs,
					key: s.key,
					start: s.start,
					mtimeMs,
					slot: s.slot,
				});
				continue;
			}
			const last = subset[subset.length - 1];
			onScan({
				kind: "lines",
				abs,
				rel,
				sid: basename(rel).replace(/\.jsonl$/, ""),
				key: s.key,
				cur: s.cur,
				start: s.start,
				next: last.offset + Buffer.byteLength(last.text) + 1,
				mtimeMs,
				lines: subset,
				slot: s.slot,
			});
			out.harvested++;
		}
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

// ─── routing-doctrine model classes (belt routing-policy.yaml ladder) ──────
// flash → local → cloud full models; the raw model string stays with the row.
export type ModelGroup = "flash" | "full" | "luna" | "local" | "other";

export function modelGroup(model: string): ModelGroup {
	const m = model.toLowerCase().replace(/^[a-z0-9]+\//, ""); // strip anthropic/ etc.
	if (m.includes("flash")) return "flash";
	if (m.includes("luna")) return "luna";
	if (/(local|swarm|ollama|llama|gguf|hermes)/.test(m)) return "local";
	if (/^(claude|gpt|o[0-9]|gemini|grok|deepseek)/.test(m)) return "full";
	return "other";
}

// ─── W657 pipeline: source adapters over one shared read pass ──────────────
export interface HarvestAdapter {
	/** stats/log identity */
	name: string;
	/** cursor namespaces this adapter consumes (parallel windows/guards) */
	prefixes: string[];
	/** per-prefix never-opened recency windows (days) */
	windows?: (number | undefined)[];
	/** per-prefix legacy-cursor refusal */
	guards?: (TailGuard | undefined)[];
	/** consume one per-(file×slot) verdict; cursor writes stay with the adapter */
	onScan: (scan: TailScan) => void;
	/** end-of-pass writes (rollup upserts) — still inside the shared pass tx */
	flush?: () => void;
	/** the adapter's stats object, surfaced in the pipeline result */
	stats?: () => unknown;
}

export interface PipelineResult {
	files: number; // transcripts seen in the pass
	results: unknown[]; // per-adapter stats() (null when the adapter has none)
}

/** ONE pass over the transcript root serving every registered adapter: one
 *  glob, one stat, one tail read per file — framed once, fanned to each
 *  adapter's slot. ONE BEGIN IMMEDIATE spans the pass, so adapter cursor
 *  saves and flush upserts commit atomically (a mid-pass failure rolls the
 *  whole tick back; every miner is cursor-idempotent, so a retry re-reads
 *  exactly the un-committed files). Adapters keep their per-line semantics
 *  and their own cursor namespaces. */
export function runHarvestPipeline(
	db: Database,
	adapters: HarvestAdapter[],
	opts: { root?: string; nowMs?: number } = {},
): PipelineResult {
	const prefixes: string[] = [];
	const guards: (TailGuard | undefined)[] = [];
	const windows: (number | undefined)[] = [];
	const owner = new Map<number, number>(); // slot → adapter index
	adapters.forEach((a, ai) => {
		a.prefixes.forEach((p, pi) => {
			owner.set(prefixes.length, ai);
			prefixes.push(p);
			guards.push(a.guards?.[pi]);
			windows.push(a.windows?.[pi]);
		});
	});
	db.run("BEGIN IMMEDIATE");
	try {
		const stats = scanTranscriptTails(
			db,
			{ root: opts.root, prefixes, guards, windows, nowMs: opts.nowMs },
			(scan) => {
				const ai = owner.get(scan.slot);
				if (ai !== undefined) adapters[ai].onScan(scan);
			},
		);
		for (const a of adapters) a.flush?.();
		db.run("COMMIT");
		return {
			files: stats.files,
			results: adapters.map((a) => a.stats?.() ?? null),
		};
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e;
	}
}

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
