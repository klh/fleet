import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { recoverySnapshot } from "../hooks/board/recovery.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

describe("operator recovery projection", () => {
	test("older stores report unavailable, never falsely empty evidence", () => {
		const db = new Database(":memory:");
		try {
			const s = recoverySnapshot(
				db as unknown as GovernorStore,
				null,
				1_000_000,
			);
			expect(s.incidentsAvailable).toBe(false);
			expect(s.feedbackAvailable).toBe(false);
			expect(s.incidents).toEqual([]);
		} finally {
			db.close();
		}
	});
	test("scopes every projection and outcome count, bounds history", () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE failure_incidents(project TEXT, sid TEXT, resource TEXT, attempts INTEGER, last_at INTEGER, resolved_at INTEGER, consult_id INTEGER)",
			);
			db.run(
				"CREATE TABLE consults(id INTEGER PRIMARY KEY, project TEXT, asker_sid TEXT, expert_sid TEXT, scope TEXT, state TEXT, created_at INTEGER)",
			);
			db.run(
				"CREATE TABLE consult_feedback(consult_id INTEGER, outcome TEXT, recorded_at INTEGER)",
			);
			const now = 100_000_000;
			for (let i = 0; i < 40; i++)
				db.query(
					"INSERT INTO failure_incidents VALUES('a', 'lane', 'file', 2, ?, NULL, 1)",
				).run(now - i);
			db.query(
				"INSERT INTO failure_incidents VALUES('b', 'other', 'file', 9, ?, NULL, 2)",
			).run(now);
			db.query(
				"INSERT INTO failure_incidents VALUES('a', 'old', 'file', 9, ?, NULL, 2)",
			).run(now - 86_400_001);
			db.query(
				"INSERT INTO consults VALUES(1, 'a', 'lane', 'expert', 'file', 'ANSWERED', ?), (2, 'b', 'lane', 'expert', 'file', 'ANSWERED', ?)",
			).run(now, now);
			db.query(
				"INSERT INTO consult_feedback VALUES(1, 'resolved', ?), (2, 'failed', ?)",
			).run(now, now);
			const s = recoverySnapshot(db as unknown as GovernorStore, "a", now);
			expect(s.incidents).toHaveLength(30);
			expect(
				s.incidents.every((r) => r.project === "a" && r.sid === "lane"),
			).toBe(true);
			expect(s.consults.map((r) => r.id)).toEqual([1]);
			expect(s.outcomes).toEqual({ resolved: 1 });
			expect(
				recoverySnapshot(db as unknown as GovernorStore, "all", now).outcomes,
			).toEqual({ resolved: 1, failed: 1 });
		} finally {
			db.close();
		}
	});
});
