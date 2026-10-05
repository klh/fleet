// test/quota-sweep.test.ts — W366 quota-exhaustion detection + fleet pickup.
// Everything injected: temp governor rows, temp lane logs (mtime set with
// utimesSync), a temp buckle.db, fake emit/broadcast/reclaim recorders.
// The death gate defaults (sessions table, transcript glob) are overridden
// per case — their parity with bus/lane-liveness is those modules' tests.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimesSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
	quotaSweep,
	lineIsQuota,
	auditRowIsQuota,
	projectRootOf,
} from "../hooks/lib/quota-sweep.ts";

const STALE = 16 * 60_000; // past the 15-min floor
const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "quota-sweep-"));
	dirs.push(root);
	return root;
};

// minimal governor: only the columns the sweep reads
const governor = (
	rows: Array<{ id: string; project: string; owner_sid: string }>,
): Database => {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items (id TEXT, project TEXT, state TEXT, owner_sid TEXT)",
	);
	for (const r of rows)
		db.run(
			"INSERT INTO work_items VALUES (?, ?, 'CLAIMED', ?)",
			r.id,
			r.project,
			r.owner_sid,
		);
	return db;
};

const laneLog = (
	root: string,
	sid: string,
	text: string,
	mtimeAgo = STALE,
): void => {
	mkdirSync(`${root}/.fleet`, { recursive: true });
	const p = `${root}/.fleet/lane-${sid}.log`;
	writeFileSync(p, text);
	const t = new Date(Date.now() - mtimeAgo);
	utimesSync(p, t, t);
};

const buckle = (
	root: string,
	rows: Array<Record<string, string | number | null>>,
): string => {
	const db = new Database(`${root}/buckle.db`);
	db.run(
		"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT, hint TEXT, error_code TEXT, err TEXT, why TEXT, status INTEGER)",
	);
	for (const [i, r] of rows.entries())
		db.run(
			"INSERT INTO route_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			`r${i}`,
			r.ts as string,
			r.actor ?? null,
			r.hint ?? null,
			r.error_code ?? null,
			r.err ?? null,
			r.why ?? null,
			r.status ?? null,
		);
	db.close();
	return `${root}/buckle.db`;
};

const recorders = () => {
	const emitted: Array<{ sid: string; note: string }> = [];
	const broadcasts: string[] = [];
	const reclaimed: Array<{ id: string; root: string }> = [];
	return {
		emitted,
		broadcasts,
		reclaimed,
		deps: {
			emit: (sid: string, note: string) => {
				emitted.push({ sid, note });
			},
			broadcast: (note: string) => {
				broadcasts.push(note);
				return 3;
			},
			reclaim: (id: string, root: string) => {
				reclaimed.push({ id, root });
				return { code: 0, out: "reclaimed" };
			},
		},
	};
};

const ISO = (agoMs: number): string =>
	new Date(Date.now() - agoMs).toISOString();

describe("pure helpers", () => {
	test("429 counts only on error-shaped lines (prose never matches)", () => {
		expect(
			lineIsQuota("API Error: Request rejected (429) · litellm.RateLimitError"),
		).toBeTrue();
		expect(
			lineIsQuota("some 429 rate from belt/route_audit in a report paragraph"),
		).toBeFalse();
		expect(
			lineIsQuota('Error: {"code":1210,"message":"insufficient balance"}'),
		).toBeTrue();
		expect(
			lineIsQuota("Your credit balance is too low to access the API"),
		).toBeTrue();
	});
	test("audit row: status 429 or hard signature in text fields", () => {
		expect(auditRowIsQuota({ ts: ISO(0), actor: "a", status: 429 })).toBeTrue();
		expect(
			auditRowIsQuota({
				ts: ISO(0),
				actor: "a",
				error_code: "rate_limit_error",
			}),
		).toBeTrue();
		expect(
			auditRowIsQuota({
				ts: ISO(0),
				actor: "a",
				err: "insufficient_quota",
				status: null,
			}),
		).toBeTrue();
		expect(
			auditRowIsQuota({ ts: ISO(0), actor: "a", status: 200 }),
		).toBeFalse();
	});
	test("project identity strips the common git dir", () => {
		expect(projectRootOf("/x/repo/.git")).toBe("/x/repo");
		expect(projectRootOf("/x/repo")).toBe("/x/repo");
	});
});

describe("quotaSweep", () => {
	test("terminal 429 tail + dead sid → exhausted, pickup fires", async () => {
		const root = tempRoot();
		laneLog(
			root,
			"autow1",
			"working\nAPI Error: Request rejected (429) rate_limit_error\n",
		);
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([
				{ id: "W1", project: `${root}/.git`, owner_sid: "autow1" },
			]),
			buckleDb: null,
			probeLive: () => false,
			act: true,
			...rec.deps,
			recentEmit: () => false,
		});
		expect(report.verdicts[0]?.exhausted).toBeTrue();
		expect(rec.reclaimed).toEqual([{ id: "W1", root }]);
		expect(rec.emitted.length).toBe(1);
		expect(rec.broadcasts.length).toBe(1);
		expect(rec.broadcasts[0]).toContain("autow1");
	});

	test("lane still writing (fresh log) → live, watched not reclaimed", async () => {
		const root = tempRoot();
		laneLog(root, "autow2", "API Error (429)\n", 60_000); // 1 min ago
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W2", project: root, owner_sid: "autow2" }]),
			buckleDb: null,
			probeLive: () => false, // even with dead transcripts, fresh log wins
			act: true,
			...rec.deps,
		});
		expect(report.verdicts[0]?.exhausted).toBeFalse();
		expect(report.verdicts[0]?.live).toBeTrue();
		expect(rec.reclaimed.length).toBe(0);
		expect(rec.broadcasts.length).toBe(0);
	});

	test("fresh claimant transcript → live (backoff), no action", async () => {
		const root = tempRoot();
		laneLog(root, "autow3", "API Error (429)\n");
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W3", project: root, owner_sid: "autow3" }]),
			buckleDb: null,
			probeLive: () => true,
			act: true,
			...rec.deps,
		});
		expect(report.verdicts[0]?.exhausted).toBeFalse();
		expect(rec.reclaimed.length).toBe(0);
	});

	test("lane that finished (DONE last) is orphaned's job, not quota's", async () => {
		const root = tempRoot();
		laneLog(root, "autow4", "API Error (429)\n… work report …\nDONE abc1234\n");
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W4", project: root, owner_sid: "autow4" }]),
			buckleDb: null,
			probeLive: () => false,
			act: true,
			...rec.deps,
		});
		expect(report.verdicts[0]?.exhausted).toBeFalse();
		expect(report.verdicts[0]?.note).toContain("orphaned");
		expect(rec.reclaimed.length).toBe(0);
	});

	test("route_audit: attributed 429 corroborates a dead sid; others count unattributed", async () => {
		const root = tempRoot();
		const dbPath = buckle(root, [
			{ ts: ISO(10 * 60_000), actor: "k1", hint: "/w/autow5", status: 429 },
			{ ts: ISO(20 * 60_000), actor: "k2", status: 429 },
			{ ts: ISO(30 * 60_000), actor: "k1", status: 200 },
		]);
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W5", project: root, owner_sid: "autow5" }]),
			buckleDb: dbPath,
			probeLive: () => false,
			act: true,
			...rec.deps,
			recentEmit: () => false,
		});
		expect(report.verdicts[0]?.exhausted).toBeTrue();
		expect(
			report.verdicts[0]?.hits.some((h) => h.source === "route_audit"),
		).toBeTrue();
		expect(report.auditUnattributed).toBe(1);
		expect(rec.reclaimed.length).toBe(1);
	});

	test("route_audit lookback window respected", async () => {
		const root = tempRoot();
		const dbPath = buckle(root, [
			{ ts: ISO(3 * 3600_000), actor: "k1", hint: "/w/autow6", status: 429 },
		]);
		const report = await quotaSweep({
			db: governor([{ id: "W6", project: root, owner_sid: "autow6" }]),
			buckleDb: dbPath,
			probeLive: () => false,
			lookbackMs: 90 * 60_000,
		});
		expect(report.verdicts[0]?.exhausted).toBeFalse();
		expect(report.auditUnattributed).toBe(0);
	});

	test("emit dedup: recent event skips emit, reclaim still runs", async () => {
		const root = tempRoot();
		laneLog(root, "autow7", "API Error (429)\n");
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W7", project: root, owner_sid: "autow7" }]),
			buckleDb: null,
			probeLive: () => false,
			act: true,
			...rec.deps,
			recentEmit: () => true,
		});
		expect(report.verdicts[0]?.exhausted).toBeTrue();
		expect(rec.reclaimed.length).toBe(1);
		expect(rec.emitted.length).toBe(0);
		expect(rec.broadcasts.length).toBe(1); // broadcast is per-sweep, not deduped
	});

	test("report-only (no --act): verdicts surface, nothing mutates", async () => {
		const root = tempRoot();
		laneLog(root, "autow8", "API Error (429)\n");
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W8", project: root, owner_sid: "autow8" }]),
			buckleDb: null,
			probeLive: () => false,
			...rec.deps,
		});
		expect(report.verdicts[0]?.exhausted).toBeTrue();
		expect(report.actions.length).toBe(0);
		expect(rec.reclaimed.length).toBe(0);
	});

	test("transcript tail: no lane log, stale transcript carries the signature", async () => {
		const root = tempRoot();
		const projects = mkdtempSync(join(tmpdir(), "quota-sweep-tp-"));
		dirs.push(projects);
		const t = `${projects}/autow10.jsonl`;
		writeFileSync(
			t,
			`{"type":"assistant"}\n{"type":"error","error":{"type":"rate_limit_error"}}\n`,
		);
		const stale = new Date(Date.now() - STALE);
		utimesSync(t, stale, stale);
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W10", project: root, owner_sid: "autow10" }]),
			buckleDb: null,
			projectsDir: projects,
			probeLive: () => false,
			act: true,
			...rec.deps,
			recentEmit: () => false,
		});
		expect(report.verdicts[0]?.exhausted).toBeTrue();
		expect(
			report.verdicts[0]?.hits.some((h) => h.source === "transcript"),
		).toBeTrue();
		expect(rec.reclaimed.length).toBe(1);
	});

	test("OPEN-decision holder is never reclaimed, only alerted", async () => {
		const root = tempRoot();
		laneLog(root, "autow11", "API Error (429)\n");
		const rec = recorders();
		const report = await quotaSweep({
			db: governor([{ id: "W11", project: root, owner_sid: "autow11" }]),
			buckleDb: null,
			probeLive: () => false,
			act: true,
			waitingSids: new Set(["autow11"]),
			...rec.deps,
		});
		expect(report.verdicts[0]?.exhausted).toBeFalse();
		expect(report.verdicts[0]?.note).toContain("OPEN decision");
		expect(rec.reclaimed.length).toBe(0);
		expect(rec.broadcasts.length).toBe(0);
	});

	test("missing buckle db → source skipped gracefully", async () => {
		const root = tempRoot();
		const report = await quotaSweep({
			db: governor([{ id: "W9", project: root, owner_sid: "autow9" }]),
			buckleDb: `${root}/nope.db`,
			probeLive: () => false,
		});
		expect(report.auditDb).toBe(`${root}/nope.db`);
		expect(report.verdicts[0]?.exhausted).toBeFalse();
	});
});
