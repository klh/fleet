// test/report-savings.test.ts — W894: starter-evidence parsing, lane usage
// totals, savings math vs the cold-raw baseline, cell/footer rendering, and
// the condense stage-event reader behind the CLONE/SAVED report columns.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheRow } from "../hooks/lib/cache-telemetry.ts";
import {
	BYTES_PER_TOKEN,
	cloneCell,
	condenseStageEvents,
	fleetDaySavings,
	fleetDayStartMs,
	fmtTok,
	itemSavingsRow,
	laneUsageTotals,
	readStarterEvidence,
	savedCell,
	savingsFooter,
	savingsFor,
} from "../hooks/lib/report-savings.ts";

const tmp = mkdtempSync(join(tmpdir(), "report-sav-"));
const fleet = tmp;

const laneLog = (sid: string, lines: string[]): void =>
	writeFileSync(join(fleet, `lane-${sid}.log`), `${lines.join("\n")}\n`);

const row = (
	lane: string,
	u: { i: number; r: number; c?: number },
	at = "2026-10-19T15:00:00Z",
): CacheRow => ({
	lane,
	task: "t",
	boundary: { provider: "p", tenant: "", region: "", model: "m" },
	usage: { in_tok: u.i, out_tok: 10, cache_r: u.r, cache_c: u.c ?? 0 },
	requests: 1,
	wallMs: 100,
	at,
});

// real starterStartLine shapes (scripts/lib/lane-starter.ts)
const FORK_LINE =
	"STARTER W894 — forked starter f4dae8ae032c (cached, session e02f5a14-5a06-4fe9-8b08-6726a4665937; saved ≈60.3s vs cold, W768 bench)";
const FORK_SEEDED =
	"STARTER W1 — forked starter abc123def456 (seeded, session s-1, seed 21s; saved ≈60.3s vs cold, W768 bench)";
const COLD_LINE = "STARTER W2 — cold start (no fork adapter for codex)";

describe("readStarterEvidence (W894)", () => {
	test("parses cached fork + cold lines; seed variant", () => {
		laneLog("fork-lane", [FORK_LINE, "[claude-code:unrecognized_model] {}"]);
		laneLog("seed-lane", [FORK_SEEDED]);
		laneLog("cold-lane", [COLD_LINE]);
		expect(readStarterEvidence(fleet, "fork-lane")).toEqual({
			mode: "fork",
			version: "f4dae8ae032c",
			source: "cached",
			session: "e02f5a14-5a06-4fe9-8b08-6726a4665937",
			savedS: 60.3,
		});
		expect(readStarterEvidence(fleet, "seed-lane")?.savedS).toBe(60.3);
		expect(readStarterEvidence(fleet, "cold-lane")).toEqual({
			mode: "cold",
			reason: "no fork adapter for codex",
		});
	});
	test("missing log / no STARTER line → null", () => {
		expect(readStarterEvidence(fleet, "nope")).toBeNull();
		laneLog("quiet-lane", ["DISPATCHED W3 → quiet-lane"]);
		expect(readStarterEvidence(fleet, "quiet-lane")).toBeNull();
	});
});

describe("savings math (W894)", () => {
	test("usage totals sum per lane", () => {
		const totals = laneUsageTotals([
			row("a", { i: 100, r: 900 }),
			row("a", { i: 50, r: 10 }),
			row("b", { i: 7, r: 0 }),
		]);
		expect(totals.get("a")).toEqual({
			in: 150,
			cacheR: 910,
			cacheC: 0,
			out: 20,
			requests: 2,
		});
		expect(totals.get("b")?.requests).toBe(1);
	});
	test("saved = cacheR + fork + condense; pct vs cold-raw", () => {
		const r = savingsFor(
			{ in: 1000, cacheR: 9000, cacheC: 0, out: 0, requests: 3 },
			{ starterFork: true, condenseBytes: 4 * 250 },
		);
		expect(r.savedTok).toBe(18582);
		expect(r.coldRaw).toBe(19582);
		expect(r.pct).toBe(95);
	});
	test("zero usage → null pct; negative condense clamps", () => {
		expect(savingsFor(undefined, {})).toEqual({
			savedTok: 0,
			coldRaw: 0,
			pct: null,
		});
		const z = savingsFor(
			{ in: 0, cacheR: 0, cacheC: 0, out: 0, requests: 0 },
			{ condenseBytes: -400 },
		);
		expect(z.savedTok).toBe(0);
	});
});

describe("cells + footer (W894)", () => {
	test("cloneCell variants", () => {
		expect(cloneCell(null)).toBe("-");
		expect(
			cloneCell({
				mode: "fork",
				version: "v",
				source: "cached",
				session: "s",
				savedS: 60.3,
			}),
		).toBe("fork 60s");
		expect(cloneCell({ mode: "cold", reason: "r" })).toBe("cold");
	});
	test("savedCell renders only measurable savings", () => {
		expect(savedCell({ savedTok: 0, pct: null })).toBe("-");
		expect(savedCell({ savedTok: 34_100_000, pct: 97 })).toBe(
			"~34.1M (~97%)",
		);
		expect(fmtTok(933)).toBe("933");
		expect(fmtTok(12_300)).toBe("12.3k");
	});
	test("itemSavingsRow: null sid → dashes; forked sid reads the lane log", () => {
		laneLog("fork-lane", [FORK_LINE]);
		const usage = laneUsageTotals([row("fork-lane", { i: 652, r: 69_504 })]);
		const r1 = itemSavingsRow(null, usage, fleet);
		expect(r1.clone).toBe("-");
		expect(r1.saved).toBe("-");
		const r2 = itemSavingsRow("fork-lane", usage, fleet);
		expect(r2.clone).toBe("fork 60s");
		expect(r2.savedTok).toBe(69_504 + 9_332);
	});
});

describe("condense stage events (W894)", () => {
	const stage = (payload: unknown): { payload: unknown } =>
		typeof payload === "string"
			? { payload }
			: { payload: JSON.stringify(payload) };
	test("filters to stage rows, skips damaged payloads, keeps null condensed", () => {
		const db = {
			query: (_sql: string) => ({
				all: () => [
					stage({ for: "prompt.stages", originalBytes: 4000, condensedBytes: 2000 }),
					stage({ for: "llm.call", originalBytes: 9999, condensedBytes: 0 }),
					stage("not json {"),
					{ payload: 42 },
				],
			}),
		};
		const rows = condenseStageEvents(db, 0);
		expect(rows).toEqual([{ originalBytes: 4000, condensedBytes: 2000 }]);
	});
	test("fleet-day sums cache + forks + condense shrink over today's rows", () => {
		const rows = [
			row("fork-lane", { i: 652, r: 69_504 }, "2026-10-19T15:00:00Z"),
			row("old-lane", { i: 5000, r: 0 }, "2026-10-01T09:00:00Z"),
		];
		const day = fleetDaySavings({
			rows,
			fleet,
			dayStartMs: fleetDayStartMs(Date.parse("2026-10-19T15:30:00Z")),
		});
		expect(day).toMatchObject({ lanes: 1, forks: 1, savedTok: 78_836 });
	});
	test("fleet-day adds the condense term; footer renders one line", () => {
		const db = {
			query: (_sql: string) => ({
				all: () => [
					stage({ for: "prompt.stages", originalBytes: 4000, condensedBytes: 2000 }),
				],
			}),
		};
		const day = fleetDaySavings({
			rows: [],
			fleet,
			dayStartMs: fleetDayStartMs(Date.parse("2026-10-19T15:30:00Z")),
			stageDb: db,
		});
		expect(day.savedTok).toBe(500);
		expect(savingsFooter(day)).toBe(
			"SAVED fleet-day ~500 tok (~100% vs cold-raw baseline, 0 lanes, 0 forks)",
		);
	});
	test("BYTES_PER_TOKEN contract", () => {
		expect(BYTES_PER_TOKEN).toBe(4);
	});
});
