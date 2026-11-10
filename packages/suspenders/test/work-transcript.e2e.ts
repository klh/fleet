// work-transcript.e2e.ts — W2956: the per-lane transcript audit face. Pure
// core tests on fabricated windows/rows (overlap pairs, per-lane union spend,
// unknown-ledger honesty), plus one hermetic CLI e2e: a scratch world with its
// own governor.db (GOVERNOR_STORE_URL=local + HOME=root, trigger-stamped shred
// columns) and a fabricated buckle ledger, driving `coord transcript --item`
// end to end — claim windows, windowed ledger spend, and the dual-work
// overlap finding all witnessed through the real CLI.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ClaimWindow } from "../hooks/lib/work/work-timing.ts";
import {
	laneSegments,
	overlapPairs,
} from "../hooks/lib/work/work-transcript.ts";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

const HOUR = 3_600_000;

test.describe("@unit", () => {
	const databases: Database[] = [];
	const directories: string[] = [];
	test.afterEach(() => {
		for (const db of databases.splice(0)) db.close();
		for (const dir of directories.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	// two lanes' windows time-intersecting on one item — the dual-work finding
	test("overlapPairs: intersection found, same-lane churn skipped", () => {
		const now = Date.now();
		const wins: ClaimWindow[] = [
			{ sid: "laneA", start: now - 20 * 60_000, end: now - 5 * 60_000 },
			{ sid: "laneB", start: now - 10 * 60_000, end: now },
		];
		const pairs = overlapPairs("W1", wins);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].a.sid).toBe("laneA");
		expect(pairs[0].b.sid).toBe("laneB");
		expect(pairs[0].start).toBe(now - 10 * 60_000);
		expect(pairs[0].end).toBe(now - 5 * 60_000);
	});

	// sequential same-lane re-claims must not read as dual work
	test("overlapPairs: disjoint and same-lane windows are quiet", () => {
		const wins: ClaimWindow[] = [
			{ sid: "laneA", start: 1_000, end: 2_000 },
			{ sid: "laneA", start: 3_000, end: 4_000 },
			{ sid: "laneB", start: 5_000, end: 6_000 },
		];
		expect(overlapPairs("W1", wins)).toHaveLength(0);
	});

	// per-lane rollup: rows inside the lane's window union count once — a
	// bucket straddling two sequential windows must not double-count
	test("laneSegments: union-of-windows spend, straddling bucket counted once", () => {
		const hour = 1_700_000_000_000; // fixed hour for bucket math
		const rows = [
			{
				bucket: `${new Date(hour).toISOString().slice(0, 13)}:00`,
				sid: "laneA",
				group: "glm",
				inTok: 1000,
				outTok: 500,
				cacheR: 2000,
				cacheC: 100,
				requests: 4,
				costUsd: 0.01,
			},
		];
		const segs = laneSegments(
			[
				{ sid: "laneA", start: hour, end: hour + 10 * 60_000 },
				{ sid: "laneA", start: hour + 20 * 60_000, end: hour + HOUR },
			],
			rows,
		);
		const a = segs.get("laneA");
		expect(a?.fresh).toBe(1000);
		expect(a?.cached).toBe(2100);
		expect(a?.out).toBe(500);
		expect(a?.requests).toBe(4);
		expect(a?.costUsd).toBe(0.01);
	});

	// unknown ledger = honesty: segments render reported:false with zeroed
	// numerics (never fabricated spend), windows still listed
	test("laneSegments: missing ledger reports unknown, never zero", () => {
		const segs = laneSegments(
			[{ sid: "laneA", start: 1_000, end: 2_000 }],
			null,
		);
		const a = segs.get("laneA");
		expect(a?.reported).toBe(false);
		expect(a?.fresh).toBe(0);
		expect(a?.windows).toHaveLength(1);
	});

	// the hermetic CLI e2e: real coord door, real governor.db, real ledger.
	// laneA claims→done, laneB claims while laneA lives — the stall-duplicate
	// shape; both lanes' ledger rows fall in the SAME hour bucket so the
	// windowed rollup attributes each row to exactly its lane.
	test("transcript CLI: item audit joins windows, spend, overlap; sid trail", () => {
		const f = cliFixture("w2956", { env: { GOVERNOR_STORE_URL: "local" } });
		try {
			const proj = f.run("coord.ts", ["project", "identity"]).out.trim();
			const hourStart = Math.floor(Date.now() / HOUR) * HOUR;
			const claimA = hourStart + 5 * 60_000;
			const claimB = hourStart + 10 * 60_000;
			const doneA = hourStart + 20 * 60_000;
			// bus events via the subprocess seam — the schema trigger stamps
			// the project/work shred columns from the payload
			const evt = (ts: number, kind: string, by: string): void => {
				f.ins(
					"INSERT INTO events (ts, source, kind, scope, payload) VALUES (?, ?, ?, ?, ?)",
					[
						ts,
						"work",
						kind,
						"suspenders",
						JSON.stringify({ project: proj, work: "W1", by }),
					],
				);
			};
			evt(claimA, "work.claimed", "laneA");
			evt(claimB, "work.claimed", "laneB");
			evt(doneA, "work.done", "laneA");
			// fabricated buckle ledger at the default resolveBuckleDb() spot
			// ($HOME/.claude/local-llm/buckle.db — HOME is the fixture's): the
			// per-lane minted keys resolve by api_keys.name, the shared hour
			// bucket covers both windows so each row attributes once per lane
			const ledgerDir = join(f.HOME, ".claude", "local-llm");
			mkdirSync(ledgerDir, { recursive: true });
			const ledger = new Database(join(ledgerDir, "buckle.db"));
			databases.push(ledger);
			ledger.exec("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
			ledger.exec(
				"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER, requests INTEGER, cost_usd REAL)",
			);
			ledger.exec(
				"INSERT INTO api_keys VALUES ('ka', 'laneA'), ('kb', 'laneB')",
			);
			const bucket = `${new Date(hourStart).toISOString().slice(0, 13)}:00`;
			ledger.exec(
				`INSERT INTO router_usage VALUES ('${bucket}', 'ka', 'glm', 1000, 500, 2000, 100, 4, 0.01),
('${bucket}', 'kb', 'glm', 200, 50, 300, 0, 1, NULL)`,
			);
			// item mode: the cross-lane audit — windows replayed from the bus,
			// ledger rows joined by api_keys.name, dual-work overlap found
			const r = JSON.parse(
				f.run("coord.ts", ["transcript", "--item", "W1", "--json"]).out,
			) as {
				mode: string;
				total: number;
				lanes: {
					sid: string;
					windows: { sid: string; start: number; end: number }[];
					fresh: number;
					cached: number;
					out: number;
					requests: number;
					costUsd: number | null;
					reported: boolean;
				}[];
				overlaps: {
					a: { sid: string };
					b: { sid: string };
					start: number;
					end: number;
				}[];
			};
			expect(r.mode).toBe("item");
			expect(r.total).toBe(3);
			expect(r.lanes).toHaveLength(2);
			const a = r.lanes.find((l) => l.sid === "laneA");
			const b = r.lanes.find((l) => l.sid === "laneB");
			expect(a?.reported).toBe(true);
			expect(a?.windows).toEqual([{ sid: "laneA", start: claimA, end: doneA }]);
			expect(a?.fresh).toBe(1000);
			expect(a?.cached).toBe(2100);
			expect(a?.out).toBe(500);
			expect(a?.requests).toBe(4);
			expect(a?.costUsd).toBe(0.01);
			expect(b?.windows[0]?.start).toBe(claimB);
			expect(b?.fresh).toBe(200);
			expect(b?.cached).toBe(300);
			expect(b?.requests).toBe(1);
			expect(b?.costUsd).toBe(null);
			expect(r.overlaps).toHaveLength(1);
			expect(r.overlaps[0]?.a.sid).toBe("laneA");
			expect(r.overlaps[0]?.b.sid).toBe("laneB");
			expect(r.overlaps[0]?.start).toBe(claimB);
			expect(r.overlaps[0]?.end).toBe(doneA);
			// the human face renders the same findings
			const human = f.run("coord.ts", ["transcript", "--item", "W1"]).out;
			expect(human).toContain("per-lane audit");
			expect(human).toContain("OVERLAP laneA × laneB");
			// sid mode: the lane's own trail — its claim (by=laneB), not laneA's
			const trail = JSON.parse(
				f.run("coord.ts", ["transcript", "laneB", "--json"]).out,
			) as { mode: string; shown: number; events: { kind: string }[] };
			expect(trail.mode).toBe("sid");
			expect(trail.shown).toBe(1);
			expect(trail.events[0]?.kind).toBe("work.claimed");
			// overview: lanes on the bus grouped by source column
			const ov = JSON.parse(
				f.run("coord.ts", ["transcript", "--json"]).out,
			) as { mode: string; lanes: { source: string; n: number }[] };
			expect(ov.mode).toBe("overview");
			expect(ov.lanes.find((l) => l.source === "work")?.n).toBe(3);
		} finally {
			f.cleanup();
		}
	});
});
