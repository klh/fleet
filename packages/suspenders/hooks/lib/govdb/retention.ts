// hooks/lib/govdb/retention.ts — W174: TTL + archive-before-delete for the
// unbounded governor tables (events, route_audit, auth_events, usage_rollup,
// admin_audit). Rows that age out are appended as NDJSON under
// ${HOME}/.cache/claude-governor/archive/ before deletion, so gc loses
// nothing it deletes. Batches bound the memory (streams-over-buffers law) —
// no whole-table SELECT.

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type { GovernorStore } from "./govdb.ts";

const BATCH = 500;

// computed per call — tests pin HOME, never at module load
export function archiveDir(): string {
	return join(process.env.HOME ?? ".", ".cache", "claude-governor", "archive");
}

// W2274: archive-then-delete PER BATCH, keyed on the table's primary key.
// The pre-fix shape selected `WHERE ts < cut LIMIT 500` with no cursor and
// ran one DELETE only after the loop — any table with >BATCH stale rows
// re-selected the same 500 forever, appending duplicate NDJSON lines and
// never deleting. Now each batch is archived, then exactly those rows are
// deleted by pk in one tx, so the next SELECT sees the remainder.
// Concurrent inserts are safe: new rows carry now-ish ts values above the
// cut, so they never enter a batch. Archive-write failure THROWS (the
// caller decides prune-skipping) — nothing is deleted that was not
// archived first. Returns the archived (and deleted) row count.
export function archiveAndPrune(
	store: GovernorStore,
	spec: {
		table: string;
		tsCol: string;
		cut: number;
		cols: string[];
		// the table's PRIMARY KEY columns — the per-batch DELETE rides them
		pkCols: string[];
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
	const sel = store.query(
		`SELECT ${spec.cols.join(", ")} FROM ${spec.table} WHERE ${spec.tsCol} < ?${floorSql} LIMIT ${BATCH}`,
	);
	const pkWhere = spec.pkCols.map((c) => `${c} = ?`).join(" AND ");
	const params =
		spec.floorCol && spec.floorVal != null
			? [spec.cut, spec.floorVal]
			: [spec.cut];
	let total = 0;
	let wrote = false;
	for (;;) {
		const rows = sel.all(...params) as Record<string, unknown>[];
		if (!rows.length) break;
		if (!wrote) mkdirSync(dir, { recursive: true });
		const file = join(
			dir,
			`${spec.table}-${new Date().toISOString().slice(0, 10)}.ndjson`,
		);
		const lines = rows.map((r) => JSON.stringify(r)).join("\n");
		appendFileSync(file, `${lines}\n`);
		wrote = true;
		total += rows.length;
		// archive-then-delete per batch: exactly the rows just archived.
		// PK ordering guarantees forward progress even when ts ties (every
		// ts < cut, so the same row can never satisfy the next SELECT).
		store.transaction(() => {
			for (const r of rows) {
				store.run(
					`DELETE FROM ${spec.table} WHERE ${pkWhere}`,
					...spec.pkCols.map((c) => r[c]),
				);
			}
		})();
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
