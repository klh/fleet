// W2059 — lane-backfill tests: closer-key ledger sum, event replay, and the
// itemAttribution tier (ledger > backfill > self-report). Real functions,
// temp ledger + in-memory graph.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
	BACKFILL_EVENT,
	attributionBackfills,
	backfillForItem,
	backfillSpend,
	closerKeyNames,
} from "./lane-backfill.ts";
import { itemAttribution } from "./lane-spend.ts";

const T0 = Date.parse("2026-10-27T08:00:00Z");
const HOUR = 3_600_000;
const SID = "1a536a25-2b22-44eb-9e82-8b1aa7d74174";

const dir = mkdtempSync(join(tmpdir(), "lane-backfill-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ledger = (): string => {
	const p = join(dir, `ledger-${Math.random().toString(36).slice(2)}.db`);
	const d = new Database(p);
	d.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
	d.run(
		"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, model TEXT DEFAULT '', in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER, requests INTEGER)",
	);
	d.run("INSERT INTO api_keys VALUES ('k_sid', ?)", [SID]);
	d.run("INSERT INTO api_keys VALUES ('k_int', 'claude-cli-interactive')");
	d.run("INSERT INTO api_keys VALUES ('k_lane', 'autow1-lane')");
	const b = `${new Date(T0).toISOString().slice(0, 13)}:00`;
	d.run(
		"INSERT INTO router_usage VALUES (?, 'k_sid', 'glm-5.3-flash', '', 100, 10, 0, 0, 2)",
		[b],
	);
	d.run(
		"INSERT INTO router_usage VALUES (?, 'k_int', 'glm-5.3-flash', '', 1000, 50, 20000, 1000, 7)",
		[b],
	);
	return p;
};

describe("backfillSpend", () => {
	test("sums sid + interactive keys in-window, excludes lane keys, splits groups", () => {
		const s = backfillSpend(ledger(), SID, T0, T0 + HOUR / 2);
		expect(s).not.toBeNull();
		expect(s?.fresh).toBe(1100); // 100 (sid key) + 1000 (interactive)
		expect(s?.out).toBe(60);
		expect(s?.cached).toBe(21000);
		expect(s?.requests).toBe(9);
		expect(Object.keys(s?.groups ?? {})).toEqual(["glm-5.3-flash"]);
	});

	test("bucket straddling the window start attributes", () => {
		// window starts mid-bucket: bucket start < fromMs but +1h overlaps
		const s = backfillSpend(ledger(), SID, T0 + 30 * 60_000, T0 + HOUR);
		expect(s?.fresh).toBe(1100);
	});

	test("window outside all buckets → null (honest no-data)", () => {
		const p = ledger();
		expect(backfillSpend(p, SID, T0 + 2 * HOUR, T0 + 3 * HOUR)).toBeNull();
		expect(backfillSpend(p, "", T0, T0 + HOUR)).toBeNull();
	});
});

describe("closerKeyNames", () => {
	test("sid + interactive knobs, deduped", () => {
		process.env.SUSPENDERS_INTERACTIVE_KEYS = "int-a, int-b";
		expect(closerKeyNames("s1")).toEqual(["s1", "int-a", "int-b"]);
		delete process.env.SUSPENDERS_INTERACTIVE_KEYS;
		expect(closerKeyNames("claude-cli-interactive")).toEqual([
			"claude-cli-interactive",
		]);
	});
});

describe("attributionBackfills", () => {
	const db = (): Database => {
		const d = new Database(":memory:");
		d.run(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
		);
		return d;
	};
	test("last event wins per item; garbage skipped", () => {
		const d = db();
		const stamp = (fresh: number): string =>
			JSON.stringify({ fresh, cached: 0, out: 0, requests: 0, groups: {} });
		const ev = (payload: string): void =>
			d
				.prepare(
					"INSERT INTO events (ts, kind, project, payload) VALUES (?, ?, 'p', ?)",
				)
				.run(T0, BACKFILL_EVENT, payload);
		ev(JSON.stringify({ work: "W1", backfill: stamp(5) }));
		ev(JSON.stringify({ work: "W1", backfill: stamp(9) }));
		ev("not json");
		ev(JSON.stringify({ work: "W2" }));
		const m = attributionBackfills(d, "p");
		expect(m.get("W1")?.fresh).toBe(9);
		expect(m.has("W2")).toBe(false);
	});
});

describe("itemAttribution backfill tier", () => {
	const db = (): Database => {
		const d = new Database(":memory:");
		d.run(
			"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, updated_at INTEGER)",
		);
		d.run(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
		);
		return d;
	};
	const ev = (
		d: Database,
		ts: number,
		kind: string,
		payload: Record<string, unknown>,
	): void =>
		d
			.prepare(
				"INSERT INTO events (ts, kind, project, payload) VALUES (?, ?, 'p', ?)",
			)
			.run(ts, kind, JSON.stringify(payload));

	test("ledger attributed nothing → the work.attribution stamp stands in", () => {
		const d = db();
		d.prepare(
			"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('p', 'W1', 'DONE', 't', ?)",
		).run(T0);
		ev(d, T0 - 2_000, "work.claimed", { work: "W1", by: "lane-x" });
		ev(d, T0 - 1_000, "work.done", { work: "W1" });
		ev(d, T0 - 900, BACKFILL_EVENT, {
			work: "W1",
			backfill: JSON.stringify({
				fresh: 301478,
				cached: 0,
				out: 8510,
				requests: 35,
				groups: {
					"glm-5.3-flash": {
						in: 301478,
						out: 8510,
						cacheR: 0,
						cacheC: 0,
						requests: 35,
					},
				},
			}),
		});
		const a = itemAttribution(d, "p", T0, null).get("W1");
		expect(a?.fresh).toBe(301478);
		expect(a?.out).toBe(8510);
		expect(a?.requests).toBe(35);
		expect(Object.keys(a?.groups ?? {})).toEqual(["glm-5.3-flash"]);
	});

	test("no claim window / no stamp → dashes stay (honest no-data)", () => {
		const d = db();
		d.prepare(
			"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('p', 'W1', 'DONE', 't', ?)",
		).run(T0);
		ev(d, T0 - 2_000, "work.claimed", { work: "W1", by: "s1" });
		ev(d, T0 - 1_000, "work.done", { work: "W1" });
		const a = itemAttribution(d, "p", T0, null).get("W1");
		expect(a?.fresh + a?.cached + a?.out).toBe(0);
	});
});
