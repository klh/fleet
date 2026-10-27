// w2179-ladder-repair.test.ts — W2179: the merge ladder's dead ends get exits.
// Contract: merge-tree conflict text is recognised as a conflict; one open
// rebase/repair item per branch (no W1.1 vs W1.10 cross-match, closed items
// don't block a fresh mint); a DONE branch deferred past the max age raises
// exactly one NEED_DECISION, and clearing forgets it.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearStuck,
	ensureRepairItem,
	isConflictWhy,
	noteStuckDefer,
} from "../hooks/lib/fleet-loop/ladder-repair.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";

const REPO = join(import.meta.dir, "..");
const PROJECT = projectIdentity(REPO);

const store = () => {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,title TEXT,state TEXT); CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	return db;
};

const minter = (db: Database) => {
	const titles: string[] = [];
	const enqueue = (title: string) => {
		const id = `W9${titles.length}`;
		titles.push(title);
		db.query(
			"INSERT INTO work_items(project,id,title,state) VALUES(?,?,?,'READY')",
		).run(PROJECT, id, title);
		return id;
	};
	return { titles, enqueue };
};

describe("W2179 conflict recognition", () => {
	test("merge-tree preview failure and guard conflicts read as conflicts", () => {
		expect(isConflictWhy("Error: review context: git merge-tree failed")).toBe(
			true,
		);
		expect(
			isConflictWhy(
				"merge guard: candidate merge conflicts or failed: abc1234",
			),
		).toBe(true);
		expect(
			isConflictWhy("review is stale: base or applicable instructions changed"),
		).toBe(false);
	});
});

describe("W2179 repair items", () => {
	test("rebase mints once; park reuses the open item", () => {
		const db = store();
		const m = minter(db);
		const opts = { db: db as unknown as GovernorStore, enqueue: m.enqueue };
		const first = ensureRepairItem(
			REPO,
			"suspenders/W1.1",
			"rebase",
			"x",
			opts,
		);
		const again = ensureRepairItem(
			REPO,
			"suspenders/W1.1",
			"repair",
			"y",
			opts,
		);
		expect(first).toEqual({ id: "W90", minted: true });
		expect(again).toEqual({ id: "W90", minted: false });
		expect(m.titles[0]).toBe(
			"rebase suspenders/W1.1 onto main (merge ladder conflict)",
		);
	});

	test("W1.10 never matches W1.1's item; a closed item allows a fresh mint", () => {
		const db = store();
		const m = minter(db);
		const opts = { db: db as unknown as GovernorStore, enqueue: m.enqueue };
		ensureRepairItem(REPO, "suspenders/W1.1", "rebase", "x", opts);
		expect(
			ensureRepairItem(REPO, "suspenders/W1.10", "repair", "y", opts).minted,
		).toBe(true);
		db.run("UPDATE work_items SET state='DONE'");
		expect(
			ensureRepairItem(REPO, "suspenders/W1.1", "repair", "z", opts).minted,
		).toBe(true);
		expect(m.titles[2]).toBe(
			"repair suspenders/W1.1 (parked by the merge ladder)",
		);
	});
});

describe("W2179 stuck DONE alarm", () => {
	test("raises one NEED_DECISION past the max age, clear forgets", () => {
		const db = store();
		const file = join(mkdtempSync(join(tmpdir(), "w2179-")), "stuck.json");
		const base = { file, db: db as unknown as GovernorStore, maxAgeMs: 1000 };
		const b = "suspenders/W7";
		expect(
			noteStuckDefer(REPO, b, "W7", "review required: a", { ...base, now: 0 }),
		).toBe(false);
		expect(
			noteStuckDefer(REPO, b, "W7", "review required: b", {
				...base,
				now: 999,
			}),
		).toBe(false);
		expect(
			noteStuckDefer(REPO, b, "W7", "review required: c", {
				...base,
				now: 1000,
			}),
		).toBe(true);
		expect(
			noteStuckDefer(REPO, b, "W7", "review required: d", {
				...base,
				now: 5000,
			}),
		).toBe(false);
		const rows = db.query("SELECT kind, scope, payload FROM events").all() as {
			kind: string;
			scope: string;
			payload: string;
		}[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.kind).toBe("NEED_DECISION");
		expect(rows[0]?.scope).toBe(b);
		expect(JSON.parse(rows[0]?.payload ?? "{}").note).toContain(
			"review required: c",
		);
		clearStuck(file, b);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
		expect(noteStuckDefer(REPO, b, "W7", "again", { ...base, now: 6000 })).toBe(
			false,
		);
	});
});
