// reader-cursor — the incremental decisions reconcile (events_since cursor)
// reaches the same fixpoint as the full scan, reads only above the mark, and
// the periodic full pass still converges rows the cursor skipped.
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

const world = scratchWorld({ prefix: "reader-cursor-" });
process.env.HOME = world.home;
process.env.GOVERNOR_STORE_URL = "local";
const { db } = await import("./context.ts");
const { syncDecisions } = await import("./lanes.ts");
const { readCursor, resetFullReconcile } = await import("./reader-cursor.ts");

test.afterAll(() => world.clean());

const emit = (target, note) =>
	Number(
		db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'asker', 'NEED_DECISION', NULL, ?, ?) RETURNING id",
			)
			.get(Date.now(), JSON.stringify({ note }), target).id,
	);

// every column except the per-write random token: the fixpoint shape
const snapshot = () =>
	db
		.query(
			"SELECT event_id, target, asked_by, project, task_id, question, state, delivery, created_at FROM decisions ORDER BY event_id",
		)
		.all();

const maxId = () => Number(db.query("SELECT MAX(id) AS m FROM events").get().m);

test("incremental passes match a full reconcile and advance the cursor @unit", () => {
	resetFullReconcile(Date.now()); // incremental mode
	const a = emit("lane-a", "first fork?");
	syncDecisions({ force: true });
	expect(readCursor("board.decisions")).toBe(maxId());
	const b = emit("lane-b", "second fork?");
	const c = emit("lane-c", "third fork?");
	syncDecisions({ force: true });
	expect(readCursor("board.decisions")).toBe(maxId());
	const incremental = snapshot();
	const ids = incremental.map((r) => r.event_id);
	for (const id of [a, b, c]) expect(ids).toContain(id);
	// a forced full pass over the same bus changes nothing: same fixpoint
	process.env.SUSPENDERS_BOARD_FULL_RECONCILE_MS = "0";
	try {
		syncDecisions({ force: true });
	} finally {
		delete process.env.SUSPENDERS_BOARD_FULL_RECONCILE_MS;
	}
	expect(snapshot()).toEqual(incremental);
});

test("a row below the mark waits for the periodic full pass @unit", () => {
	resetFullReconcile(Date.now());
	const below = emit("lane-d", "orphaned fork?");
	syncDecisions({ force: true });
	// simulate a qualifying change below the cursor: the decision row vanishes
	db.query("DELETE FROM decisions WHERE event_id = ?").run(below);
	syncDecisions({ force: true });
	const has = () =>
		snapshot().some((r) => Number(r.event_id) === Number(below));
	expect(has()).toBe(false); // incremental: id <= cursor is not rescanned
	resetFullReconcile(0); // the full-reconcile window has lapsed
	syncDecisions({ force: true });
	expect(has()).toBe(true);
});
