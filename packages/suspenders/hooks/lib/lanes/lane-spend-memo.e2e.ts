// laneSpendRows memo — one ledger read per ledger change, however many
// projects ask; any committed write (WAL growth / checkpoint) re-reads.
import { Database } from "bun:sqlite";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { laneSpendRows, ledgerStamp } from "./lane-spend.ts";

test("laneSpendRows serves the memo until the ledger changes @unit", () => {
	const world = scratchWorld({ prefix: "lane-spend-memo-" });
	try {
		const path = join(world.home, "buckle.db");
		const w = new Database(path, { create: true });
		w.run("PRAGMA journal_mode=WAL");
		w.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
		w.run(
			"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER, requests INTEGER)",
		);
		w.run("INSERT INTO api_keys VALUES ('k1', 'lane-1')");
		w.run(
			"INSERT INTO router_usage VALUES ('2026-10-29T10:00', 'k1', 'glm', 10, 1, 0, 0, 1)",
		);
		const first = laneSpendRows(path, "2026-10-29T00:00");
		expect(first.map((r) => r.inTok)).toEqual([10]);
		// unchanged ledger: the very same array (no re-read)
		expect(laneSpendRows(path, "2026-10-29T00:00")).toBe(first);
		const before = ledgerStamp(path);
		w.run(
			"INSERT INTO router_usage VALUES ('2026-10-29T11:00', 'k1', 'glm', 5, 1, 0, 0, 1)",
		);
		expect(ledgerStamp(path)).not.toBe(before);
		const next = laneSpendRows(path, "2026-10-29T00:00");
		expect(next).not.toBe(first);
		expect(next.map((r) => r.inTok)).toEqual([10, 5]);
		w.close();
	} finally {
		world.clean();
	}
});
