// W892 — work report tests: ST letters, the prototype golden table, window
// parse, and reportRows selection (hermetic: ledger pinned null = zero spend).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	agentClock,
	buildReportTable,
	compactTokens,
	DEFAULT_DONE_WINDOW_MS,
	DONE_ROW_CAP,
	parseReportWindow,
	type ReportRow,
	reportLetter,
	reportRows,
	TASK_CAP,
} from "./work-report.ts";

const T0 = 1_700_000_000_000;

describe("reportLetter", () => {
	test("riding/queued/done/failed letters", () => {
		expect(reportLetter("CLAIMED")).toBe("R");
		expect(reportLetter("RUNNING")).toBe("R");
		expect(reportLetter("READY")).toBe("Q");
		expect(reportLetter("DONE")).toBe("D");
		expect(reportLetter("FAILED")).toBe("F");
	});
});

describe("parseReportWindow", () => {
	test("s/m/h/d units; garbage and out-of-range → null", () => {
		expect(parseReportWindow("45m")).toBe(45 * 60_000);
		expect(parseReportWindow("2h")).toBe(2 * 3_600_000);
		expect(parseReportWindow("2d")).toBe(2 * 86_400_000);
		expect(parseReportWindow("90s")).toBe(90_000);
		expect(parseReportWindow("0m")).toBeNull();
		expect(parseReportWindow("31d")).toBeNull();
		expect(parseReportWindow("48")).toBeNull();
		expect(parseReportWindow("week")).toBeNull();
	});
});

describe("compactTokens + agentClock", () => {
	test("token compaction thresholds", () => {
		expect(compactTokens(9_999)).toBe("9999");
		expect(compactTokens(60_000)).toBe("60k");
		expect(compactTokens(172_345)).toBe("172k");
		expect(compactTokens(8_800_000)).toBe("8.8M");
		expect(compactTokens(17_100_000)).toBe("17.1M");
	});
	test("agent clock: minutes, padded hours, day fold", () => {
		expect(agentClock(0)).toBe("0m");
		expect(agentClock(12 * 60_000)).toBe("12m");
		expect(agentClock((60 + 56) * 60_000)).toBe("1h56m");
		expect(agentClock((21 * 60 + 37) * 60_000)).toBe("21h37m");
		expect(agentClock((9 * 1440 + 22 * 60 + 5) * 60_000)).toBe("9d22h");
	});
});

const proto = (p: Record<string, unknown>): ReportRow =>
	({
		id: "W1",
		state: "CLAIMED",
		title: "t",
		fresh: 0,
		cached: 0,
		out: 0,
		agentMs: 0,
		...p,
	}) as ReportRow;

describe("buildReportTable — the prototype golden", () => {
	test("renders the coordinator prototype table (fixed pads)", () => {
		const table = buildReportTable([
			proto({
				id: "W887",
				title: "board micro-metrics: spark",
				fresh: 172000,
				out: 69000,
				agentMs: 12 * 60000,
			}),
			proto({
				id: "W843",
				state: "DONE",
				title: "Buckle: reconcile provider ledger",
				fresh: 176000,
				cached: 8624000,
				out: 29988,
				agentMs: 36 * 60000,
			}),
			proto({
				id: "W552",
				title: "Save governed IKEA recordings for the archive",
				fresh: 520000,
				cached: 4680000,
				out: 98572,
				agentMs: (21 * 60 + 37) * 60000,
			}),
			proto({
				id: "W688.4",
				title: "Enterprise W235 packaging: hub",
				fresh: 60000,
				out: 24012,
				agentMs: 116 * 60000,
			}),
			proto({
				id: "W782",
				title: "review: skipped/postponed/pruned",
				agentMs: 90 * 60000,
			}),
			proto({
				id: "W179.2",
				state: "READY",
				title: "notification fan-out — NEED_DECISION",
				agentMs: (9 * 1440 + 22 * 60) * 60000,
			}),
			proto({
				id: "W688.7.1",
				state: "DONE",
				title: "hub serves the enterprise tier",
				fresh: 10431000,
				cached: 6669000,
				out: 185020,
				agentMs: 55 * 60000,
			}),
		]);
		expect(table).toBe(
			[
				"ITEM      ST  TASK                        TOKENS  CACHE  OUT/MIN   AGENT",
				"--------  --  --------------------------  ------  -----  -------  ------",
				"W887      R   board micro-metrics: spark    172k     0%     5750     12m",
				"W843      D   Buckle: reconcile provider    8.8M    98%      833     36m",
				"W552      R   Save governed IKEA recordi    5.2M    90%       76  21h37m",
				"W688.4    R   Enterprise W235 packaging:     60k     0%      207   1h56m",
				"W782      R   review: skipped/postponed/       -      -        0   1h30m",
				"W179.2    Q   notification fan-out — NEE       -      -        0   9d22h",
				"W688.7.1  D   hub serves the enterprise    17.1M    39%     3364     55m",
			].join("\n"),
		);
	});

	test("TASK truncates at 26 with no ellipsis; zero-spend shows dashes", () => {
		const t = buildReportTable([
			proto({ id: "WA", title: "x".repeat(40) }),
			proto({ id: "WB", state: "FAILED", title: "short" }),
		]);
		const lines = t.split("\n");
		expect(TASK_CAP).toBe(26);
		expect(lines[2].includes(`${"x".repeat(TASK_CAP)}  `)).toBe(true);
		expect(lines[3]).toContain("F");
		expect(lines[3]).toContain("  -  ");
	});
});

describe("reportRows", () => {
	test("riding+queued+capped-done merged by recency; ids strict; window bounds", () => {
		const d = new Database(":memory:");
		d.run(
			"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, updated_at INTEGER)",
		);
		d.run(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
		);
		const add = (id: string, state: string, age: number): void =>
			d
				.prepare(
					"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('p', ?, ?, ?, ?)",
				)
				.run(id, state, `t-${id}`, T0 - age);
		add("W1", "RUNNING", 1_000);
		add("W2", "READY", 2_000);
		add("W3", "DONE", 3_000);
		add("W4", "DONE", 10 * 86_400_000);
		add("W5", "FAILED", 4_000);
		const { rows, missing } = reportRows(d, "p", { now: T0, ledger: null });
		expect(missing).toEqual([]);
		expect(rows.map((r) => r.id)).toEqual(["W1", "W2", "W3"]);
		expect(rows.map((r) => reportLetter(r.state))).toEqual(["R", "Q", "D"]);
		const ids = reportRows(d, "p", {
			ids: ["W5", "W9"],
			now: T0,
			ledger: null,
		});
		expect(ids.rows.map((r) => r.id)).toEqual(["W5"]);
		expect(ids.missing).toEqual(["W9"]);
		const win = reportRows(d, "p", {
			now: T0,
			doneWindowMs: 1_000,
			ledger: null,
		});
		expect(win.rows.map((r) => r.id)).toEqual(["W1", "W2"]);
		expect(win.missing).toEqual([]);
		d.close();
	});

	test("done rows cap at DONE_ROW_CAP within the window", () => {
		const d = new Database(":memory:");
		d.run(
			"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, updated_at INTEGER)",
		);
		d.run(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
		);
		const add = (id: string, age: number): void =>
			d
				.prepare(
					"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('p', ?, 'DONE', ?, ?)",
				)
				.run(id, `t-${id}`, T0 - age);
		for (let i = 1; i <= 7; i++) add(`W${i}`, i * 60_000);
		const { rows } = reportRows(d, "p", { now: T0, ledger: null });
		expect(rows.filter((r) => r.state === "DONE").map((r) => r.id)).toEqual([
			"W1",
			"W2",
			"W3",
			"W4",
			"W5",
		]);
		expect(rows.filter((r) => r.state === "DONE").length).toBe(DONE_ROW_CAP);
		d.close();
	});

	test("done window defaults to DEFAULT_DONE_WINDOW_MS", () => {
		const d = new Database(":memory:");
		d.run(
			"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, updated_at INTEGER)",
		);
		d.run(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
		);
		d.prepare(
			"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('p', 'WD', 'DONE', 't', ?)",
		).run(T0 - DEFAULT_DONE_WINDOW_MS - 60_000);
		const { rows } = reportRows(d, "p", { now: T0, ledger: null });
		expect(rows.map((r) => r.id)).toEqual([]);
		d.close();
	});
});
