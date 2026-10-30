// W2314 — Kueue saturation counters (docs/design/w2312-kueue-adoption.md
// pattern 2): pending (READY pool) / held (non-terminal intents with no
// live lane) / admitted (live lanes) against the ONE steady target.
// Hermetic: in-memory graph + scratch intents store + injected liveness.
import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { reserveLaunchIntent } from "../../../scripts/lib/launch-fencing.ts";
import { acquireLaunchLease } from "../../../scripts/lib/launch-preflight.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { capacityLine, reportCapacity } from "./report-capacity.ts";
import { reportFace } from "./report-face.ts";
import { renderStatusline } from "./work-report-modes.ts";
import { footerLine, renderReport } from "./work-report-render.ts";
import { buildReportContract, type ReportRow } from "./work-report.ts";

const PROJ = "/repo/.git";
const T0 = 1_700_000_000_000;

/** graph fixture: READY pool rows + CLAIMED rows (the live lanes' items). */
function graph(): Database {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, updated_at INTEGER, owner_sid TEXT)",
	);
	const add = (id: string, state: string): void => {
		d.prepare(
			"INSERT INTO work_items (project, id, state, title, updated_at, owner_sid) VALUES (?, ?, ?, ?, ?, ?)",
		).run(PROJ, id, state, `t-${id}`, T0, null);
	};
	add("W1", "READY");
	add("W2", "READY");
	add("W3", "READY");
	add("W4", "CLAIMED");
	add("W5", "CLAIMED");
	return d;
}

/** scratch intents store: one reserved (uncertain → held) intent on W9. */
function intents(): GovernorStore {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,owner_sid TEXT,updated_at INTEGER,state TEXT)",
	);
	d.run("INSERT INTO work_items VALUES (?, 'W9', 'lane', 100, 'CLAIMED')", [
		PROJ,
	]);
	const store = d as unknown as GovernorStore;
	acquireLaunchLease(store, PROJ, "lane", "n");
	reserveLaunchIntent(
		store,
		{
			project: PROJ,
			item: "W9",
			sid: "lane",
			nonce: "n",
			revision: 100,
			executor: process.execPath, // reserve stamps host/birth; pid stays null
		},
		3,
	);
	return store;
}

/** one working row → contract with (or without) a saturation triple. */
const contractWithCap = (
	cap: {
		pending: number;
		held: number;
		admitted: number;
		target: number | null;
	} | null,
): ReturnType<typeof buildReportContract> => {
	const row: ReportRow = {
		id: "W1",
		state: "CLAIMED",
		title: "t",
		fresh: 1,
		cached: 0,
		cacheRead: null,
		cacheCreation: null,
		out: 1,
		agentMs: 60_000,
		model: "",
		effort: null,
		consulted: false,
		blindCache: false,
		updatedAt: T0,
		ownerSid: "s1",
		hub: null,
		requests: null,
		lastActivityAgoMs: null,
		lastOutAgoMs: null,
		stalled: false,
		decision: false,
		spendReported: true,
		project: PROJ,
	};
	return buildReportContract([row], {
		project: PROJ,
		now: T0,
		...(cap ? { capacity: cap } : {}),
	});
};

test.describe("@unit", () => {
	test.describe("reportCapacity", () => {
		test("pending = READY pool; admitted = live registry lanes", () => {
			const live = new Set(["s1", "s2"]); // s3's lane is dead
			const c = reportCapacity(
				graph(),
				PROJ,
				[
					{ sid: "s1", item: "W4" },
					{ sid: "s2", item: "W5" },
					{ sid: "s3", item: "W6" },
				],
				(l) => live.has(l.sid),
			);
			expect(c.pending).toBe(3);
			expect(c.admitted).toBe(2);
		});

		test("held counts only intents with NO live lane on the item", () => {
			// W9's intent is foreign-host (unknown verdict) — held; W4's intent
			// is covered by its live lane — admitted, NOT held twice.
			const store = intents();
			const d = graph();
			const cap = reportCapacity(
				d,
				PROJ,
				[
					{ sid: "s1", item: "W4" },
					{ sid: "lane", item: "W9" }, // live lane covers the intent
				],
				() => true, // every registry lane live
				store,
			);
			expect(cap.held).toBe(0); // W9 covered; nothing else holds
			const cap2 = reportCapacity(
				d,
				PROJ,
				[{ sid: "s1", item: "W4" }], // W9's lane NOT in the registry
				() => true,
				store,
			);
			expect(cap2.held).toBe(1); // W9's intent now holds a slot
		});

		test("no intents table = 0 held, never a dead report", () => {
			const c = reportCapacity(graph(), PROJ, [], () => false, undefined);
			expect(c.held).toBe(0);
			expect(c.pending).toBe(3);
			expect(c.admitted).toBe(0);
		});

		test("capacityLine: saturation vs target; live-only when no target", () => {
			expect(
				capacityLine({ pending: 27, held: 1, admitted: 4, target: 8 }),
			).toBe("5/8 · held 1 · pending 27");
			expect(
				capacityLine({ pending: 27, held: 0, admitted: 4, target: null }),
			).toBe("live 4 · held 0 · pending 27");
		});

		test("the contract carries capacity; unset renders null (§5 unknown ≠ zero)", () => {
			const row: ReportRow = {
				id: "W1",
				state: "READY",
				title: "t",
				fresh: 0,
				cached: 0,
				cacheRead: null,
				cacheCreation: null,
				out: 0,
				agentMs: 0,
				model: "",
				effort: null,
				consulted: false,
				blindCache: false,
				updatedAt: T0,
				ownerSid: null,
				hub: null,
				requests: null,
				lastActivityAgoMs: null,
				lastOutAgoMs: null,
				stalled: false,
				decision: false,
				spendReported: false,
				project: PROJ,
			};
			const withCap = buildReportContract([row], {
				project: PROJ,
				now: T0,
				capacity: { pending: 2, held: 1, admitted: 3, target: 8 },
			});
			expect(withCap.capacity).toEqual({
				pending: 2,
				held: 1,
				admitted: 3,
				target: 8,
			});
			const bare = buildReportContract([row], { project: PROJ, now: T0 });
			expect(bare.capacity).toBeNull();
		});

		test("footer + statusline + tty render the saturation line FROM the contract", () => {
			const c = contractWithCap({
				pending: 27,
				held: 1,
				admitted: 4,
				target: 8,
			});
			expect(footerLine(c, [])).toContain("5/8 · held 1 · pending 27");
			expect(renderStatusline(c)).toContain("5/8 · held 1 · pending 27");
			expect(renderReport(c, { format: "tty" }) ?? "").toContain(
				"5/8 · held 1 · pending 27",
			);
			// null capacity renders NO saturation line (§5 unknown ≠ zero)
			const bare = contractWithCap(null);
			expect(footerLine(bare, [])).not.toContain("held");
			expect(renderStatusline(bare)).not.toContain("held");
		});

		test("the board face stamps the saturation line (reportFace.capacity)", () => {
			const d = new Database(":memory:");
			d.run(
				"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, owner_sid TEXT, updated_at INTEGER)",
			);
			d.run(
				"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, work TEXT, payload TEXT)",
			);
			d.prepare(
				"INSERT INTO work_items VALUES (?, 'W1', 'READY', 't', NULL, ?)",
			).run(PROJ, T0);
			// no lanes.json beside the fixture project root + no intents table —
			// capacity degrades to pending/target, never dies
			const face = reportFace(d, PROJ, { now: T0, ledger: null });
			expect(face.capacity).toContain("pending 1");
			expect(face.capacity).toContain("held 0");
		});
	});
});
