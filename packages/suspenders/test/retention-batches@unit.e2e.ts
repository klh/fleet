// retention-batches@unit.e2e.ts — W2274: archiveAndPrune must terminate and
// prune when more than one BATCH (500) of rows is stale. The old loop re-read
// the same LIMIT window forever and deleted only after the loop, so coord gc
// never finished on a real governor.db. Proof: 1234 stale rows + 3 fresh →
// exactly 1234 archived lines, 1234 deleted, the fresh rows survive.
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w2274-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const retention = await import("../hooks/lib/govdb/retention.ts");
process.env.HOME = REAL_HOME;

const DAY = 86_400_000;
const ARCHIVE = join(HOME, "archive");

test.afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("archiveAndPrune: >BATCH stale rows terminate, archive == deleted", () => {
	const db = govdb.openGovernorDb();
	const now = Date.now();
	const ins = db.query(
		"INSERT INTO events (ts, source, kind) VALUES (?, ?, ?)",
	);
	for (let i = 0; i < 1234; i++) ins.run(now - 40 * DAY + i, "t", "old.event");
	for (let i = 0; i < 3; i++) ins.run(now, "t", "new.event");
	const n = retention.archiveAndPrune(db, {
		table: "events",
		tsCol: "ts",
		cut: now - 30 * DAY,
		dir: ARCHIVE,
		cols: ["id", "ts", "source", "kind"],
		pkCols: ["id"],
	});
	expect(n).toBe(1234);
	const lines = readdirSync(ARCHIVE)
		.flatMap((f) => readFileSync(join(ARCHIVE, f), "utf8").split("\n"))
		.filter(Boolean);
	expect(lines.length).toBe(1234);
	expect(JSON.parse(lines[0]).kind).toBe("old.event");
	expect(lines[0]).not.toContain("__rid");
	const left = db
		.query("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind")
		.all();
	expect(left).toEqual([{ kind: "new.event", n: 3 }]);
});

test("archiveAndPrune: floor predicate still bounds the cut", () => {
	const db = govdb.openGovernorDb();
	db.query("DELETE FROM events").run();
	const now = Date.now();
	const ins = db.query(
		"INSERT INTO events (ts, source, kind) VALUES (?, ?, ?)",
	);
	for (let i = 0; i < 700; i++) ins.run(now - 40 * DAY, "t", "old.event");
	const ids = db.query("SELECT id FROM events ORDER BY id").all() as {
		id: number;
	}[];
	const floor = ids[599]?.id ?? 0;
	const n = retention.archiveAndPrune(db, {
		table: "events",
		tsCol: "ts",
		cut: now - 30 * DAY,
		floorCol: "id",
		floorVal: floor,
		dir: join(HOME, "archive-floor"),
		cols: ["id", "ts", "source", "kind"],
		pkCols: ["id"],
	});
	expect(n).toBe(600);
	const left = db.query("SELECT COUNT(*) AS n FROM events").get() as {
		n: number;
	};
	expect(left.n).toBe(100);
});
