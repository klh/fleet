// hooks/lib/work-edit.test.ts — W1128 editWorkItem: terminal refusal, the
// from→to changed map, validate-before-write, no-op and CLAIMED pass-through.
// In-memory fixture store, real function (repro-gate.test.ts pattern).
import { describe, expect, test } from "bun:test";
import { openMemoryStore, type GovernorStore } from "./govdb-store.ts";
import {
	editPayload,
	editSteer,
	editWorkItem,
	EDIT_REFUSES,
} from "./work-edit.ts";

const P = "/fixture/fleet.git";

const DDL =
	"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, requires TEXT, tags TEXT, effort TEXT, evidence TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))";

function fixtureStore(): GovernorStore {
	const db = openMemoryStore();
	db.run(DDL);
	return db;
}

function seed(
	db: GovernorStore,
	id: string,
	state = "READY",
	owner: string | null = null,
	ts = Date.now(),
): void {
	db.run(
		"INSERT INTO work_items (project, id, title, state, owner_sid, priority, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)",
		P,
		id,
		`item ${id}`,
		state,
		owner,
		ts,
		ts,
	);
}

const rowOf = (db: GovernorStore, id: string): Record<string, unknown> =>
	db
		.query("SELECT * FROM work_items WHERE project=? AND id=?")
		.get(P, id) as Record<string, unknown>;

describe("EDIT_REFUSES", () => {
	test("exactly the terminal ledger states", () => {
		expect([...EDIT_REFUSES].sort()).toEqual([
			"CANCELLED",
			"DONE",
			"FAILED",
			"SUPERSEDED",
		]);
	});
});

describe("editWorkItem — refusals", () => {
	test("missing item, empty patch, terminal states", () => {
		const db = fixtureStore();
		expect(editWorkItem(db, P, "W404", { title: "x" })).toEqual({
			ok: false,
			error: "no such work item: W404",
		});
		seed(db, "W1");
		expect(editWorkItem(db, P, "W1", {}).error).toMatch(/nothing to amend/);
		for (const state of EDIT_REFUSES) {
			seed(db, `W-${state}`, state);
			expect(editWorkItem(db, P, `W-${state}`, { title: "x" }).error).toMatch(
				new RegExp(`${state} — terminal`),
			);
		}
		// a refused item keeps its record
		expect(rowOf(db, "W1").title).toBe("item W1");
	});

	test("validation errors leave the row untouched", () => {
		const db = fixtureStore();
		seed(db, "W1");
		seed(db, "W2");
		expect(editWorkItem(db, P, "W1", { tag: "bad tag" }).error).toMatch(
			/invalid tag/,
		);
		expect(editWorkItem(db, P, "W1", { priority: 1.5 }).error).toMatch(
			/needs an integer/,
		);
		expect(editWorkItem(db, P, "W1", { title: "   " }).error).toMatch(
			/non-empty/,
		);
		// multi-field patch with one bad value applies nothing
		expect(editWorkItem(db, P, "W2", { title: "new", tag: "nope!" }).ok).toBe(
			false,
		);
		expect(rowOf(db, "W2").title).toBe("item W2");
	});
});

describe("editWorkItem — in-place amend", () => {
	test("changed map carries from→to and the row updates", () => {
		const db = fixtureStore();
		const seededAt = Date.now() - 10;
		seed(db, "W1", "READY", null, seededAt);
		const r = editWorkItem(db, P, "W1", {
			title: "  amended title  ",
			desc: "what this item is now",
			priority: 3,
		});
		expect(r).toMatchObject({
			ok: true,
			state: "READY",
			owner: null,
		});
		if (!r.ok) return;
		expect(r.changed.title).toEqual({
			from: "item W1",
			to: "amended title",
		});
		expect(r.changed.description).toEqual({
			from: null,
			to: "what this item is now",
		});
		expect(r.changed.priority).toEqual({ from: 0, to: 3 });
		const row = rowOf(db, "W1");
		expect(row.title).toBe("amended title");
		expect(row.description).toBe("what this item is now");
		expect(row.priority).toBe(3);
		expect(row.updated_at as number).toBeGreaterThan(seededAt);
	});

	test("values already current → ok with an empty changed map", () => {
		const db = fixtureStore();
		seed(db, "W1");
		const r = editWorkItem(db, P, "W1", { title: "item W1" });
		expect(r).toMatchObject({ ok: true, changed: {} });
	});

	test("CLAIMED passes through with the owner surfaced", () => {
		const db = fixtureStore();
		seed(db, "W1", "CLAIMED", "autow999");
		const r = editWorkItem(db, P, "W1", { desc: "re-scoped" });
		expect(r).toMatchObject({ ok: true, state: "CLAIMED", owner: "autow999" });
	});
});

describe("editPayload / editSteer", () => {
	test("payload: new values, prior values beside them, fields + reason", () => {
		const payload = editPayload(
			{ title: { from: "old", to: "new" }, priority: { from: 0, to: 2 } },
			"owner correction",
		);
		expect(payload).toEqual({
			fields: "title,priority",
			reason: "owner correction",
			title: "new",
			"title.was": "old",
			priority: "2",
			"priority.was": "0",
		});
	});

	test("steer note only fires for a claimed item with an owner", () => {
		expect(editSteer("READY", null)).toBeNull();
		expect(editSteer("CLAIMED", null)).toBeNull();
		expect(editSteer("CLAIMED", "autow9")).toContain("coord message autow9");
	});
});
