// W892 — work report tests: ST letters, the prototype golden table, window
// parse, and reportRows selection (hermetic: ledger pinned null = zero spend).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	agentClock,
	buildReportTable,
	CACHE_LEGEND,
	CACHE_MARK,
	compactTokens,
	compareItemIds,
	consultedItems,
	DEFAULT_DONE_WINDOW_MS,
	DONE_ROW_CAP,
	type ReportRow,
	reportBucketRank,
	reportLetter,
	reportModel,
	MODEL_CAP,
	parseReportWindow,
	reportRows,
	reportTableLinkOpts,
	TASK_CAP,
} from "./work-report.ts";

const T0 = 1_700_000_000_000;
/** W910: ESC/BEL built at runtime — never source-literal control bytes. */
const esc = String.fromCharCode(27);
const bel = String.fromCharCode(7);

/** Remove OSC 8 sequences (ESC]8;…BEL) — escape-free compare for OSC 8 tests. */
const stripEscapes = (s: string): string =>
	s.replace(new RegExp(`${esc}]8;[^${bel}]*${bel}`, "g"), "");

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
		model: "",
		effort: null,
		consulted: false,
		blindCache: false,
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
				"ITEM      ST  TASK                        TOKENS  CACHE  OUT/MIN   AGENT  MODEL  EFFORT  CONSULT",
				"--------  --  --------------------------  ------  -----  -------  ------  -----  ------  -------",
				"W887      R   board micro-metrics: spark    172k     0%     5750     12m      -       -        N",
				"W843      D   Buckle: reconcile provider    8.8M    98%      833     36m      -       -        N",
				"W552      R   Save governed IKEA recordi    5.2M    90%       76  21h37m      -       -        N",
				"W688.4    R   Enterprise W235 packaging:     60k     0%      207   1h56m      -       -        N",
				"W782      R   review: skipped/postponed/       -      -        0   1h30m      -       -        N",
				"W179.2    Q   notification fan-out — NEE       -      -        0   9d22h      -       -        N",
				"W688.7.1  D   hub serves the enterprise    17.1M    39%     3364     55m      -       -        N",
			].join("\n"),
		);
	});

	test("W943.1 blindCache: `*` marks the CACHE cell + legend line rides the table", () => {
		const spend = {
			fresh: 172000,
			out: 69000,
			agentMs: 12 * 60000,
		};
		const plain = buildReportTable([proto({ id: "W887", ...spend })]);
		expect(plain).not.toContain(CACHE_MARK);
		expect(plain).not.toContain("CACHE is a floor");
		const marked = buildReportTable([
			proto({ id: "W887", ...spend, blindCache: true }),
		]);
		const lines = marked.split("\n");
		expect(lines[2]?.includes("0%*")).toBe(true);
		expect(lines.at(-1)).toBe(CACHE_LEGEND);
		expect(marked).toContain("CACHE is a floor");
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

describe("item hyperlinks (W910)", () => {
	test("links on: ITEM ids wrapped in OSC 8 deep-links, alignment intact", () => {
		const plain = buildReportTable([proto({ id: "W887" })]);
		const linked = buildReportTable([proto({ id: "W887" })], { links: true });
		expect(linked).toContain(
			`${esc}]8;http://suspenders.local/#lanes?w=W887${bel}W887`,
		);
		expect(linked).toContain(`W887${esc}]8;${bel}`);
		// stripping the escapes must land byte-identical on the plain table
		expect(stripEscapes(linked)).toBe(plain);
	});

	test("links off: plain text only (piped/hook output never leaks escapes)", () => {
		const rows = [proto({ id: "W1" })];
		expect(buildReportTable(rows)).not.toContain(esc);
		expect(buildReportTable(rows, { links: false })).not.toContain(esc);
	});

	test("baseUrl override wins over the default base", () => {
		const t = buildReportTable([proto({ id: "W1" })], {
			links: true,
			baseUrl: "http://board.lan:7799",
		});
		expect(t).toContain(`${esc}]8;http://board.lan:7799/#lanes?w=W1${bel}`);
	});

	test("reportTableLinkOpts — TTY gate, NO_HYPERLINK kill switch, env base", () => {
		const saved = {
			no: process.env.SUSPENDERS_NO_HYPERLINK,
			base: process.env.SUSPENDERS_REPORT_LINK_BASE,
		};
		try {
			delete process.env.SUSPENDERS_NO_HYPERLINK;
			delete process.env.SUSPENDERS_REPORT_LINK_BASE;
			expect(reportTableLinkOpts(true)).toEqual({
				links: true,
				baseUrl: "http://suspenders.local",
			});
			expect(reportTableLinkOpts(false).links).toBe(false);
			process.env.SUSPENDERS_NO_HYPERLINK = "1";
			expect(reportTableLinkOpts(true).links).toBe(false);
			process.env.SUSPENDERS_REPORT_LINK_BASE = "http://b:1";
			expect(reportTableLinkOpts(true).baseUrl).toBe("http://b:1");
		} finally {
			if (saved.no === undefined) delete process.env.SUSPENDERS_NO_HYPERLINK;
			else process.env.SUSPENDERS_NO_HYPERLINK = saved.no;
			if (saved.base === undefined)
				delete process.env.SUSPENDERS_REPORT_LINK_BASE;
			else process.env.SUSPENDERS_REPORT_LINK_BASE = saved.base;
		}
	});
});

describe("reportRows", () => {
	test("pool merges riding+queued+capped-done; ids strict; window bounds", () => {
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

describe("W909 — MODEL / EFFORT / CONSULT columns", () => {
	// minimal graph + bus: the schema reportRows/itemAttribution replay against
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
	test("reportModel: top group + '+' when several; tie → name; cap; none → ''", () => {
		const g = (i: number, o: number) => ({
			in: i,
			out: o,
			cacheR: 0,
			cacheC: 0,
			requests: 0,
		});
		expect(reportModel({})).toBe("");
		expect(reportModel({ a: g(1, 2) })).toBe("a");
		expect(reportModel({ a: g(9, 0), b: g(1, 1) })).toBe("a+");
		expect(reportModel({ b: g(5, 0), a: g(0, 5) })).toBe("a+"); // tie → name asc
		expect(reportModel({ a: g(0, 0) })).toBe(""); // zero-spend never renders
		expect(MODEL_CAP).toBe(16);
		expect(reportModel({ "averyveryverylongmodelname": g(1, 1) })).toBe(
			"averyveryverylon",
		);
	});
	test("consultedItems: consult + knowledge.enqueued links, other projects out", () => {
		const d = db();
		const ev = (kind: string, payload: unknown, project = "p"): void =>
			d
				.prepare(
					"INSERT INTO events (ts, kind, project, payload) VALUES (?, ?, ?, ?)",
				)
				.run(T0, kind, project, JSON.stringify(payload));
		ev("consult", { work: "W1", project: "p" });
		ev("consult.answer", { consult: "C1", state: "KB", work: "W1" });
		ev("knowledge.enqueued", { work: "W2", qid: 1 });
		ev("knowledge.enqueued", { work: "W9", qid: 2 }, "other");
		ev("broadcast", { work: "W3" });
		expect([...consultedItems(d, "p")].sort()).toEqual(["W1", "W2"]);
		d.close();
	});
	test("reportRows: effort + consulted flow through attribution replay", () => {
		const d = db();
		const item = (id: string, t: number): void =>
			d
				.prepare(
					"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('p', ?, 'DONE', 't', ?)",
				)
				.run(id, t);
		const ev = (ts: number, kind: string, payload: unknown): void =>
			d
				.prepare(
					"INSERT INTO events (ts, kind, project, payload) VALUES (?, ?, 'p', ?)",
				)
				.run(ts, kind, JSON.stringify(payload));
		item("W1", T0 - 1_000);
		item("W2", T0 - 2_000);
		ev(T0 - 1_500, "work.done", { work: "W1", effort: "high" });
		ev(T0 - 1_600, "consult", { work: "W2" });
		const { rows } = reportRows(d, "p", { now: T0, ledger: null });
		const w1 = rows.find((r) => r.id === "W1");
		const w2 = rows.find((r) => r.id === "W2");
		expect(w1?.effort).toBe("high");
		expect(w1?.consulted).toBe(false);
		expect(w2?.effort).toBeNull();
		expect(w2?.consulted).toBe(true);
		d.close();
	});
});

describe("W964 — deterministic row order", () => {
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
	const add = (
		d: Database,
		id: string,
		state: string,
		age: number,
	): void =>
		d
			.prepare(
				"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('p', ?, ?, ?, ?)",
			)
			.run(id, state, `t-${id}`, T0 - age);

	test("compareItemIds: digit runs compare as numbers", () => {
		expect(compareItemIds("W9", "W49")).toBeLessThan(0);
		expect(compareItemIds("W49", "W953")).toBeLessThan(0);
		expect(compareItemIds("W49", "W9")).toBeGreaterThan(0);
		expect(compareItemIds("W1", "W10")).toBeLessThan(0);
		expect(compareItemIds("W688.4", "W688.7.1")).toBeLessThan(0);
		expect(compareItemIds("W964", "W964")).toBe(0);
	});

	test("reportBucketRank: R < Q < F < D", () => {
		expect(reportBucketRank("CLAIMED")).toBeLessThan(
			reportBucketRank("READY"),
		);
		expect(reportBucketRank("READY")).toBeLessThan(
			reportBucketRank("FAILED"),
		);
		expect(reportBucketRank("FAILED")).toBeLessThan(
			reportBucketRank("DONE"),
		);
	});

	test("pool: byte-identical across runs; a spend tick never moves rows", () => {
		const d = db();
		add(d, "W964", "CLAIMED", 30_000);
		add(d, "W49", "READY", 50_000);
		add(d, "W9", "RUNNING", 30_000);
		add(d, "W953", "DONE", 40_000);
		const before = reportRows(d, "p", { now: T0, ledger: null });
		const ids = before.rows.map((r) => r.id);
		expect(ids).toEqual(["W9", "W964", "W49", "W953"]);
		expect(buildReportTable(before.rows)).toBe(
			buildReportTable(reportRows(d, "p", { now: T0, ledger: null }).rows),
		);
		d.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(
			T0,
			"W964",
		);
		const after = reportRows(d, "p", { now: T0, ledger: null });
		expect(after.rows.map((r) => r.id)).toEqual(ids);
		d.close();
	});

	test("done rows: recency cap picks WHICH, display id-ascending", () => {
		const d = db();
		add(d, "W100", "DONE", 10 * 60_000);
		add(d, "W5", "DONE", 20 * 60_000);
		add(d, "W50", "DONE", 30 * 60_000);
		add(d, "W1", "DONE", 40 * 60_000);
		add(d, "W2", "DONE", 50 * 60_000);
		add(d, "W3", "DONE", 60 * 60_000);
		add(d, "W4", "DONE", 70 * 60_000);
		const { rows } = reportRows(d, "p", { now: T0, ledger: null });
		const done = rows.filter((r) => r.state === "DONE").map((r) => r.id);
		expect(done).toEqual(["W1", "W2", "W5", "W50", "W100"]);
		expect(done.length).toBe(DONE_ROW_CAP);
		d.close();
	});

	test("--ids strict mode keeps caller order", () => {
		const d = db();
		add(d, "W9", "RUNNING", 60_000);
		add(d, "W953", "DONE", 40_000);
		const { rows, missing } = reportRows(d, "p", {
			ids: ["W953", "W9", "W9x-nope"],
			now: T0,
			ledger: null,
		});
		expect(rows.map((r) => r.id)).toEqual(["W953", "W9"]);
		expect(missing).toEqual(["W9x-nope"]);
		d.close();
	});
});
