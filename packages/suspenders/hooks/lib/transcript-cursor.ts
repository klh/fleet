// hooks/lib/transcript-cursor.ts — shared transcript-tail machinery for the
// journal miners (W127 usage-harvest, W243 activity-harvest): byte-offset
// cursors over the machine_cursors table + the sync byte-tail reader. Cursor
// keys are `<prefix>.<sha1(abs path)>` — prefix choice keeps each miner's
// cursors in its own namespace while the key derivation stays byte-identical
// across miners. W466: cursors moved OUT of the facts table (govdb v12) —
// machine bookkeeping never floods the knowledge read surface or facts_fts.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Database } from "bun:sqlite";

export interface TpCursor {
	o: number; // byte offset of the first unharvested byte
	m: number; // mtimeMs at last harvest
}

/** Sync byte tail of `path` from `start` — deterministic, no async edges. */
export function readTail(path: string, start: number): string {
	const fh = openSync(path, "r");
	try {
		const len = fstatSync(fh).size - start;
		if (len <= 0) return "";
		const buf = Buffer.allocUnsafe(len);
		readSync(fh, buf, 0, len, start);
		return buf.toString("utf8");
	} finally {
		closeSync(fh);
	}
}

const sha1 = (s: string): string => {
	const h = new Bun.CryptoHasher("sha1");
	h.update(s);
	return h.digest("hex");
};

export const cursorKey = (prefix: string, path: string): string =>
	`${prefix}.${sha1(path)}`;

const parse = (raw: string | null | undefined): TpCursor | null => {
	if (!raw) return null;
	try {
		const c = JSON.parse(raw) as { o?: unknown; m?: unknown };
		return typeof c.o === "number" && typeof c.m === "number"
			? { o: c.o, m: c.m }
			: null;
	} catch {
		return null;
	}
};

export function loadCursor(db: Database, key: string): TpCursor | null {
	const row = db
		.query("SELECT value FROM machine_cursors WHERE key = ?")
		.get(key) as { value: string | null } | null;
	return parse(row?.value);
}

export function saveCursor(
	db: Database,
	key: string,
	cur: TpCursor,
	source: string,
	nowMs: number,
): void {
	db.query(
		"INSERT INTO machine_cursors (key, value, source, ts) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts",
	).run(key, JSON.stringify(cur), source, nowMs);
}
