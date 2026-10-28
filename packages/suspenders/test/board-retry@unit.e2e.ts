// test/board-retry@unit.e2e.ts — W970: /api/retry, the board face for the
// W761 `work retry` requeue verb, plus the FAILED-card retry action.

import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { TASKS } from "../hooks/board-html/tasks.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const f = await boardFixture(0, test.afterAll);
const db = new Database(`${f.HOME}/.cache/claude-governor/governor.db`);
db.run("PRAGMA busy_timeout = 4500");
test.afterAll(() => db.close());
const P = f.MY_PROJ;
function fail(id, note) {
	db.query(
		"UPDATE work_items SET state = 'FAILED' WHERE project = ? AND id = ?",
	).run(P, id);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fixture', 'work.failed', NULL, ?, NULL)",
	).run(Date.now(), JSON.stringify({ work: id, project: P, note }));
}
function needDecision(id, question) {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 's-w970-op', 'NEED_DECISION', ?, ?, 's-w970-op')",
	).run(Date.now(), id, JSON.stringify({ project: P, work: id, question }));
}
const row = (id) =>
	db
		.query(
			"SELECT state, owner_sid FROM work_items WHERE project = ? AND id = ?",
		)
		.get(P, id);
test("validation: missing id 400, unknown item 404", async () => {
	expect((await f.post("/api/retry", { project: P })).status).toBe(400);
	const missing = await f.post("/api/retry", { project: P, id: "W99999" });
	expect(missing.status).toBe(404);
});
test("non-FAILED READY item: CLI refusal maps to 409", async () => {
	const id = f.addWork("w970 retry plain READY item");
	const r = await f.post("/api/retry", { project: P, id });
	expect(r.status).toBe(409);
	expect(String(r.json.error)).toContain("retry failed");
});
test("happy path: FAILED requeues READY with the claim cleared", async () => {
	const id = f.addWork("w970 retry happy item");
	fail(id, "lane died");
	const r = await f.post("/api/retry", { project: P, id });
	expect(r.status).toBe(200);
	expect(r.json).toEqual({ ok: true, item: id, state: "READY" });
	expect(row(id).state).toBe("READY");
	expect(row(id).owner_sid).toBeNull();
});
test("operator gate: open NEED_DECISION 409s; force requeues", async () => {
	const id = f.addWork("w970 retry operator-gated item");
	fail(id, "owner-only work");
	needDecision(id, "owner must configure the relay");
	const r = await f.post("/api/retry", { project: P, id });
	expect(r.status).toBe(409);
	expect(r.json.operatorGated).toBe(true);
	const forced = await f.post("/api/retry", { project: P, id, force: true });
	expect(forced.status).toBe(200);
	expect(row(id).state).toBe("READY");
});
test("FAILED card carries the retry action wired to /api/retry", () => {
	expect(TASKS).toContain(
		'if (t.state === \'FAILED\') html += \'<div class="kexec"><button type="button" class="kstart" data-retry=',
	);
	expect(TASKS).toContain("postJSON('/api/retry'");
});
