// test/retention-progress.e2e.ts — W2274: archiveAndPrune must make FORWARD
// PROGRESS on a table with more stale rows than one batch. The pre-fix shape
// selected `WHERE ts < cut LIMIT 500` with no pk cursor and deleted only
// after the loop, so >BATCH stale rows re-selected the same 500 forever:
// duplicate NDJSON lines, nothing ever deleted. The spec proves each row is
// archived EXACTLY ONCE across batches and the table empties. Raw temp db —
// retention.ts binds no govdb module state (w603 recipe). A second leg
// proves the heartbeat now schedules gc (maintenance task `gov-gc`) and
// that a scratch-HOME snapshot db measurably SHRINKS through
// `coord gc --vacuum` (never the live file).

import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w2274-"));
const ARCHIVE = join(HOME, ".cache/claude-governor/archive");
const { archiveAndPrune } = await import("../hooks/lib/govdb/retention.ts");
const { MAINTENANCE_TASKS } = await import(
	"../hooks/lib/fleet-loop/maintenance.ts"
);

test.describe("@api", () => {
	test.describe("W2274 retention forward progress", () => {
		const now = Date.now();
		const day = 86_400_000;
		let db: InstanceType<typeof Database>;

		test.beforeAll(() => {
			db = new Database(":memory:");
			db.run(
				"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL)",
			);
			db.run(
				"INSERT INTO route_audit (rid, ts) VALUES " +
					Array.from(
						{ length: 1250 },
						(_, i) => `('r${i}', ${now - 100 * day + i})`,
					).join(", "),
			);
		});

		test.afterAll(() => {
			db.close();
			rmSync(HOME, { recursive: true, force: true });
		});

		test("the heartbeat schedules gc on a cadence", () => {
			const t = MAINTENANCE_TASKS.find((x) => x.name === "gov-gc");
			expect(t).toBeTruthy();
			expect(t?.calendar).toEqual({ hour: 4, minute: 0 });
			expect(t?.argv("", "").slice(-2)).toEqual(["gc", "--vacuum"]);
		});

		test(">BATCH stale rows archive once each and empty the table", () => {
			const n = archiveAndPrune(db, {
				table: "route_audit",
				tsCol: "ts",
				cut: now - 90 * day,
				pkCols: ["rid"],
				dir: ARCHIVE,
				cols: ["rid", "ts"],
			});
			expect(n).toBe(1250);
			const left = db.query("SELECT COUNT(*) AS n FROM route_audit").get() as {
				n: number;
			};
			expect(left.n).toBe(0);
			// every row archived EXACTLY once — no duplicate NDJSON lines
			const f = readdirSync(ARCHIVE).find((x) => x.startsWith("route_audit-"));
			expect(f).toBeTruthy();
			const lines = readFileSync(join(ARCHIVE, f as string), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as { rid: string });
			expect(lines.length).toBe(1250);
			const rids = new Set(lines.map((r) => r.rid));
			expect(rids.size).toBe(1250);
			// rerun archives nothing (the idempotence the old shape broke)
			const again = archiveAndPrune(db, {
				table: "route_audit",
				tsCol: "ts",
				cut: now - 90 * day,
				pkCols: ["rid"],
				dir: ARCHIVE,
				cols: ["rid", "ts"],
			});
			expect(again).toBe(0);
		});
	});
});

test.describe("@api", () => {
	test.describe("W2274 gov-gc vacuum shrinks a snapshot", () => {
		const snapHome = mkdtempSync(join(tmpdir(), "suspenders-w2274-snap-"));
		const govdbPath = join(snapHome, ".cache/claude-governor/governor.db");

		test("coord gc --vacuum measurably shrinks a bloated snapshot copy", () => {
			// scratch HOME: govdb migrates a fresh file, then an events flood
			// bloats it (the incident shape) before the gc leg runs
			const setup = Bun.spawnSync(["bun", "-e", seedCode()], {
				env: {
					...process.env,
					HOME: snapHome,
					GOVDB_MOD: join(import.meta.dir, "..", "hooks/lib/govdb/govdb.ts"),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			if (setup.exitCode !== 0)
				console.error(new TextDecoder().decode(setup.stderr));
			expect(setup.exitCode).toBe(0);
			const before = statSync(govdbPath).size;
			expect(before).toBeGreaterThan(1_000_000);
			const gc = Bun.spawnSync(
				[
					"bun",
					join(import.meta.dir, "..", "hooks/bin/coord.ts"),
					"gc",
					"--days",
					"1",
					"--vacuum",
				],
				{
					env: { ...process.env, HOME: snapHome },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			if (gc.exitCode !== 0) console.error(new TextDecoder().decode(gc.stderr));
			expect(gc.exitCode).toBe(0);
			const after = statSync(govdbPath).size;
			expect(after).toBeLessThan(before / 2);
		});

		test.afterAll(() => {
			rmSync(snapHome, { recursive: true, force: true });
		});
	});
});

function seedCode(): string {
	return [
		"const g = await import(process.env.GOVDB_MOD);",
		"const db = g.openGovernorDb();",
		'const ins = db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?,?,?,?)");',
		'for (let i = 0; i < 30000; i++) ins.run(Date.now() - 2*86400000, "bench", "harvest.key", JSON.stringify({ v: "x".repeat(120), i }));',
		"db.close();",
	].join("\n");
}
