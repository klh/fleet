// W1198 — report-face tests: the board face calls THE renderer (byte-equal
// table), stamps per-row last-event ts off the shredded events column, and
// the row detail carries the item + injected lane tail. Hermetic: ledger
// pinned null = zero spend.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	lastEventMap,
	reportDefaultProject,
	reportFace,
	reportRowDetail,
} from "../hooks/lib/work/report-face.ts";
import { REPORT_GLYPHS, reportRows } from "../hooks/lib/work/work-report.ts";
import { buildReportTable } from "../hooks/lib/work/work-report-render.ts";

const T0 = 1_700_000_000_000;
const PROJECT = "/repo/.git";

/** Minimal graph fixture: work_items + shredded events (work column). */
function fixture(): Database {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, owner_sid TEXT, updated_at INTEGER)",
	);
	d.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, work TEXT, payload TEXT)",
	);
	const add = (
		id: string,
		state: string,
		age: number,
		owner: string | null = null,
	): void =>
		d
			.prepare(
				"INSERT INTO work_items (project, id, state, title, owner_sid, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(PROJECT, id, state, `task ${id}`, owner, T0 - age);
	add("W1", "RUNNING", 1_000, "sid-a");
	add("W2", "READY", 2_000);
	add("W3", "DONE", 3_000);
	const ev = (work: string, ts: number): void =>
		d
			.prepare(
				"INSERT INTO events (ts, kind, project, work, payload) VALUES (?, 'work.claimed', ?, ?, '{}')",
			)
			.run(ts, PROJECT, work);
	ev("W1", T0 - 900);
	ev("W1", T0 - 100); // latest wins
	ev("W3", T0 - 2_500);
	return d;
}

describe("reportFace", () => {
	test("table is byte-equal to THE renderer over the same rows", () => {
		const d = fixture();
		const face = reportFace(d, PROJECT, { now: T0, ledger: null });
		const { rows } = reportRows(d, PROJECT, { now: T0, ledger: null });
		expect(face.table).toBe(buildReportTable(rows));
		expect(face.project).toBe(PROJECT);
		expect(face.ts).toBe(T0);
	});

	test("rows carry ST glyphs (W1131 §3) and last-event stamps (latest wins)", () => {
		const d = fixture();
		const face = reportFace(d, PROJECT, { now: T0, ledger: null });
		const byId = new Map(face.rows.map((r) => [r.id, r]));
		expect(byId.get("W1")?.st).toBe(REPORT_GLYPHS.working);
		expect(byId.get("W2")?.st).toBe(REPORT_GLYPHS.ready);
		expect(byId.get("W3")?.st).toBe(REPORT_GLYPHS.done);
		expect(byId.get("W1")?.lastEventTs).toBe(T0 - 100);
		expect(byId.get("W3")?.lastEventTs).toBe(T0 - 2_500);
		expect(byId.get("W2")?.lastEventTs).toBeNull();
		expect(byId.get("W1")?.title).toBe("task W1");
	});

	test("lastEventMap fails soft on a pre-shred schema (no work column)", () => {
		const d = new Database(":memory:");
		d.run("CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER)");
		expect(lastEventMap(d, PROJECT).size).toBe(0);
	});

	test("reportDefaultProject: most recently touched graph, none when empty", () => {
		const d = fixture();
		expect(reportDefaultProject(d)).toBe(PROJECT);
		d.prepare(
			"INSERT INTO work_items (project, id, state, title, updated_at) VALUES ('/other/.git', 'W9', 'READY', 'x', ?)",
		).run(T0 + 5);
		expect(reportDefaultProject(d)).toBe("/other/.git");
		expect(reportDefaultProject(new Database(":memory:"))).toBeNull();
	});
});

describe("reportRowDetail", () => {
	test("item + last event + injected lane tail", () => {
		const d = fixture();
		const detail = reportRowDetail(d, PROJECT, "W1", (sid) => [
			{ text: `turn for ${sid}`, ts: "2026-10-23T00:00:00Z" },
		]);
		expect(detail?.id).toBe("W1");
		expect(detail?.state).toBe("RUNNING");
		expect(detail?.ownerSid).toBe("sid-a");
		expect(detail?.lastEventTs).toBe(T0 - 100);
		expect(detail?.laneTail[0]?.text).toBe("turn for sid-a");
	});

	test("missing item answers null; tail receives the null sid", () => {
		const d = fixture();
		expect(reportRowDetail(d, PROJECT, "W404", () => [])).toBeNull();
		const seen: (string | null)[] = [];
		reportRowDetail(d, PROJECT, "W2", (sid) => {
			seen.push(sid);
			return [];
		});
		expect(seen).toEqual([null]);
	});
});
