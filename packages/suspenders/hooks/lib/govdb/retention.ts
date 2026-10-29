// hooks/lib/govdb/retention.ts — W174: TTL + archive-before-delete for the
// unbounded governor tables (events, route_audit, auth_events, usage_rollup,
// admin_audit). Rows that age out are appended as NDJSON under
// ${HOME}/.cache/claude-governor/archive/ before deletion, so gc loses
// nothing it deletes. Batches bound the memory (streams-over-buffers law) —
// no whole-table SELECT.
import type { GovernorStore } from "./govdb.ts";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

const BATCH = 500;

// computed per call — tests pin HOME, never at module load
export function archiveDir(): string {
	return join(process.env.HOME ?? ".", ".cache", "claude-governor", "archive");
}

// append the rows older than spec.cut to <table>-<YYYY-MM-DD>.ndjson, then
// delete them. Concurrent inserts are safe: new rows carry now-ish ts values
// above the cut, so the DELETE removes only the archived set. Archive-write
// failure THROWS (the caller decides prune-skipping) — nothing is deleted
// that was not archived first. Returns the archived (and deleted) row count.
export function archiveAndPrune(
	store: GovernorStore,
	spec: {
		table: string;
		tsCol: string;
		cut: number;
		cols: string[];
		// pin the archive target (HOME races between bun test files would
		// otherwise move it mid-run)
		dir?: string;
		// W603 cursor-aware events retention: an optional second predicate —
		// a row is prunable only when stale AND every live reader has passed
		// it. floor = MIN(cursors.event_id); NULL floor (no cursor rows)
		// leaves the age-only cut. Module-local callers only: floorCol is
		// interpolated into SQL, never user input.
		floorCol?: string;
		floorVal?: number;
	},
): number {
	const dir = spec.dir ?? archiveDir();
	const floorSql =
		spec.floorCol && spec.floorVal != null ? ` AND ${spec.floorCol} <= ?` : "";
	// W2274: keyset batches — each batch is archived, then exactly that batch
	// is deleted by rowid, so the next SELECT advances. The old shape re-read
	// the same LIMIT window forever once more than BATCH rows were stale
	// (DELETE ran only after the loop) — gc never finished and never pruned.
	const sel = store.query(
		`SELECT rowid AS __rid, ${spec.cols.join(", ")} FROM ${spec.table} WHERE ${spec.tsCol} < ?${floorSql} AND rowid > ? ORDER BY rowid LIMIT ${BATCH}`,
	);
	const base =
		spec.floorCol && spec.floorVal != null
			? [spec.cut, spec.floorVal]
			: [spec.cut];
	let total = 0;
	let wrote = false;
	let after = -1;
	for (;;) {
		const rows = sel.all(...base, after) as Record<string, unknown>[];
		if (!rows.length) break;
		if (!wrote) mkdirSync(dir, { recursive: true });
		const file = join(
			dir,
			`${spec.table}-${new Date().toISOString().slice(0, 10)}.ndjson`,
		);
		const rids: number[] = [];
		const lines = rows
			.map(({ __rid, ...r }) => {
				rids.push(Number(__rid));
				return JSON.stringify(r);
			})
			.join("\n");
		appendFileSync(file, `${lines}\n`);
		wrote = true;
		store
			.query(
				`DELETE FROM ${spec.table} WHERE rowid IN (${rids.map(() => "?").join(",")})`,
			)
			.run(...rids);
		total += rows.length;
		after = rids[rids.length - 1] ?? after;
		if (rows.length < BATCH) break;
	}
	return total;
}

// the archive is the long-term store: its files age out on their own window
export function pruneArchiveFiles(days = 365, dir?: string): number {
	let n = 0;
	const cut = Date.now() - days * 86_400_000;
	const target = dir ?? archiveDir();
	try {
		for (const f of readdirSync(target)) {
			const p = join(target, f);
			if (statSync(p).mtimeMs < cut) {
				rmSync(p);
				n++;
			}
		}
	} catch {} // no archive dir yet — nothing to prune
	return n;
}
