// W2333 (Kueue F4): the terminal FAILED write carries its enumerated reason —
// classifyLaunchFailure's kind stamped as work_items.fail_reason +
// work.failed payload $.reason. In-memory fixture per the work-retry.e2e.ts
// sibling pattern (no spawn/mkdtemp surface).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import { runFailVerb } from "../hooks/lib/work/work-fail.ts";

test.describe("@unit", () => {
	const events: { kind: string; id: string; extra: Record<string, string> }[] =
		[];

	function fixture(): GovernorStore {
		events.length = 0;
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, fail_reason TEXT, claim_epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)",
		);
		db.run("CREATE TABLE sessions(sid TEXT PRIMARY KEY)");
		db.run(
			"INSERT INTO work_items VALUES ('p','W1','CLAIMED','lane','s',NULL,0,100)",
		);
		return db as unknown as GovernorStore;
	}
	const die = (m: string): never => {
		throw new Error(m);
	};

	test("fail stamps the classified kind on the row and the work.failed payload", () => {
		const store = fixture();
		const kind = runFailVerb(
			store,
			"p",
			{ id: "W1", note: "429 too many requests from upstream", as: null, epoch: 0 },
			(k, i, extra) => events.push({ kind: k, id: i, extra }),
			die,
		);
		expect(kind).toBe("rate-limit");
		expect(
			store.query("SELECT state, fail_reason FROM work_items WHERE id='W1'").get(),
		).toEqual({ state: "FAILED", fail_reason: "rate-limit" });
		expect(events[0].kind).toBe("work.failed");
		expect(events[0].extra.reason).toBe("rate-limit");
		expect(events[0].extra.note).toBe("429 too many requests from upstream");
	});

	test("an unclassifiable note still lands the enumerated unknown, never NULL", () => {
		const store = fixture();
		const kind = runFailVerb(
			store,
			"p",
			{ id: "W1", note: "lane remains incomplete after the continuation budget", as: null, epoch: 0 },
			() => {},
			die,
		);
		expect(kind).toBe("unknown");
		expect(
			store.query("SELECT fail_reason FROM work_items WHERE id='W1'").get(),
		).toEqual({ fail_reason: "unknown" });
	});

	test("transport and configuration notes classify to their kinds", () => {
		const store = fixture();
		expect(
			runFailVerb(
				store, "p",
				{ id: "W1", note: "ECONNREFUSED during launch", as: null, epoch: 0 },
				() => {}, die,
			),
		).toBe("transport");
		store.run("UPDATE work_items SET state='CLAIMED' WHERE id='W1'");
		expect(
			runFailVerb(
				store, "p",
				{ id: "W1", note: "invalid api key rejected (401)", as: null, epoch: 0 },
				() => {}, die,
			),
		).toBe("configuration");
	});

	test("a claim owned by another sid is refused — no FAILED, no reason", () => {
		const store = fixture();
		expect(() =>
			runFailVerb(
				store, "p",
				{ id: "W1", note: "429", as: "someone-else", epoch: 0 },
				() => {}, die,
			),
		).toThrow("is not an unfinished claim owned by");
		expect(
			store.query("SELECT state, fail_reason FROM work_items WHERE id='W1'").get(),
		).toEqual({ state: "CLAIMED", fail_reason: null });
	});
});
