// test/eval-replay.test.ts — W1200: replay-module semantics on synthetic
// chains + an in-memory route_audit/route_attempt fixture, and the
// hillclimb verdict rule (floor breach reverts; both-window-significant
// cost improvement keeps; noise-level gains revert first).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	aggregate,
	loadLedger,
	splitWindows,
	simulateRequest,
	replayWindow,
	type AttemptRow,
} from "../src/eval/replay.ts";
import { verdict, bootstrapDelta, type ArmScore } from "../src/eval/hillclimb.ts";

const at = (
	rid: string,
	ordinal: number,
	candidate: string,
	status: number | null,
	durationMs = 100,
	retryAfterMs: number | null = null,
): AttemptRow => ({
	rid,
	ordinal,
	ts: `2026-10-21T10:${String(ordinal).padStart(2, "0")}:00.000Z`,
	candidate,
	status,
	duration_ms: durationMs,
	retry_after_ms: retryAfterMs,
});

const freshState = () => ({
	fails: new Map<string, number>(),
	until: new Map<string, number>(),
});

const KNOBS = { num_retries: 1, allowed_fails: 3, cooldown_time: 30 };

describe("simulateRequest", () => {
	test("num_retries cap cuts the third same-row attempt", () => {
		const chain = [
			at("r1", 1, "A", 429),
			at("r1", 2, "A", 429),
			at("r1", 3, "A", 200),
		];
		const tight = simulateRequest(
			chain,
			{ num_retries: 2, allowed_fails: 99, cooldown_time: 30 },
			freshState(),
		);
		expect(tight.success).toBe(true);
		expect(tight.burn429).toBe(2);
		const zero = simulateRequest(
			chain,
			{ num_retries: 0, allowed_fails: 99, cooldown_time: 30 },
			freshState(),
		);
		expect(zero.success).toBe(false);
		expect(zero.attempts).toBe(1);
	});

	test("breaker opens after allowed_fails consecutive fails and blocks the row", () => {
		const chain1 = [
			at("r1", 1, "A", 429),
			at("r1", 2, "A", 429),
			at("r1", 3, "A", 429),
		];
		const state = freshState();
		const o1 = simulateRequest(
			chain1,
			{ num_retries: 2, allowed_fails: 3, cooldown_time: 300 },
			state,
		);
		expect(o1.burn429).toBe(3);
		expect(state.until.get("A")).toBeDefined();
		const chain2 = [at("r2", 4, "A", 200)];
		const o2 = simulateRequest(
			chain2,
			{ num_retries: 2, allowed_fails: 3, cooldown_time: 300 },
			state,
		);
		expect(o2.attempts).toBe(0);
	});

	test("success resets the breaker fail counter", () => {
		const state = freshState();
		const k = { num_retries: 0, allowed_fails: 2, cooldown_time: 30 };
		simulateRequest([at("r1", 1, "A", 429)], k, state);
		simulateRequest([at("r2", 2, "A", 200)], k, state);
		simulateRequest([at("r3", 3, "A", 429)], k, state);
		expect(state.until.size).toBe(0);
	});
});

describe("replayWindow determinism", () => {
	test("identical input yields identical outcomes", () => {
		const chains = new Map([
			["r1", [at("r1", 1, "A", 429), at("r1", 2, "A", 200)]],
			["r2", [at("r2", 2, "A", 200)]],
		]);
		const reqs = [
			{ rid: "r1", ts: "2026-10-21T10:01:00.000Z", ok: 1, duration_ms: 200, in_tok: 10, out_tok: 20 },
			{ rid: "r2", ts: "2026-10-21T10:02:00.000Z", ok: 1, duration_ms: 100, in_tok: 10, out_tok: 20 },
		];
		const a = replayWindow(reqs, chains, KNOBS);
		const b = replayWindow(reqs, chains, KNOBS);
		expect(a).toEqual(b);
	});
});

describe("aggregate + cost", () => {
	test("cost prices failures at mean tokens per success", () => {
		const outs = [
			{ success: true, burn429: 0, durationMs: 100, attempts: 1 },
			{ success: false, burn429: 2, durationMs: 100, attempts: 2 },
		];
		const m = aggregate(outs, 500);
		expect(m.requests).toBe(2);
		expect(m.successRate).toBe(0.5);
		expect(m.burn429).toBe(2);
		expect(m.cost).toBe(502);
	});

	test("bootstrapDelta is seed-stable and bounds the mean", () => {
		const base = Array.from({ length: 200 }, () => ({ success: 1 as const, cost: 10 }));
		const cand = Array.from({ length: 200 }, () => ({ success: 1 as const, cost: 5 }));
		const a = bootstrapDelta(base, cand, 200, 7);
		const b = bootstrapDelta(base, cand, 200, 7);
		expect(a.mean).toBeCloseTo(-5, 5);
		expect(a).toEqual(b);
		expect(a.lo).toBeLessThanOrEqual(a.mean + 1e-9);
	});
});

describe("verdict rule", () => {
	const arm = (dLo: number, dHi: number, dSucc: number): ArmScore => ({
		metrics: { requests: 100, successRate: 0.9, burn429: 0, cost: 0, p50: 0, p95: 0 },
		deltaCostCi: { lo: dLo, hi: dHi, mean: (dLo + dHi) / 2 },
		deltaSuccess: dSucc,
	});

	test("floor breach reverts", () => {
		expect(verdict(arm(-100, -10, -0.01), arm(-100, -10, -0.01)).verdict).toBe("REVERT");
	});

	test("both-window-significant cost improvement keeps", () => {
		expect(verdict(arm(-100, -10, 0), arm(-100, -10, 0)).verdict).toBe("KEEP");
	});

	test("noise-level train-only gain reverts first", () => {
		expect(verdict(arm(-100, -10, 0), arm(-10, 5, 0)).verdict).toBe("REVERT");
	});
});

describe("loadLedger + splitWindows", () => {
	test("loads chains from a temp ledger fixture", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1200-replay-"));
		const path = join(dir, "l.db");
		const db = new Database(path);
		db.exec(
			"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT, decision TEXT, attempts INTEGER, ok INTEGER, duration_ms INTEGER, in_tok INTEGER, out_tok INTEGER)",
		);
		db.exec(
			"CREATE TABLE route_attempt (rid TEXT, ordinal INTEGER, ts TEXT, candidate TEXT, status INTEGER, duration_ms INTEGER, retry_after_ms INTEGER)",
		);
		const insA = db.query("INSERT INTO route_audit VALUES (?,?,?,?,?,?,?,?)");
		const insR = db.query("INSERT INTO route_attempt VALUES (?,?,?,?,?,?,?)");
		insA.run("r1", "2026-10-21T10:01:00.000Z", "policy", 2, 1, 300, 5, 6);
		insA.run("r2", "2026-10-21T10:05:00.000Z", "policy", 1, 0, 50, 5, 0);
		insR.run("r1", 1, "2026-10-21T10:01:00.000Z", "A", 429, 100, null);
		insR.run("r1", 2, "2026-10-21T10:01:30.000Z", "A", 200, 200, null);
		insR.run("r2", 1, "2026-10-21T10:05:00.000Z", "A", 429, 50, null);
		db.close();
		const { requests, chains, start } = loadLedger(path);
		expect(requests.length).toBe(2);
		expect(chains.get("r1")?.length).toBe(2);
		expect(start).toContain("2026-10-21");
		rmSync(dir, { recursive: true, force: true });
	});

	test("splitWindows puts older 2/3 in train and recent 1/3 in test", () => {
		const reqs = [1, 2, 3, 4, 5, 6].map((i) => ({
			rid: `r${i}`,
			ts: `2026-10-21T10:0${i}:00.000Z`,
			ok: 1,
			duration_ms: 1,
			in_tok: 1,
			out_tok: 1,
		}));
		const { train, test, cutoff } = splitWindows(reqs);
		expect(train.length).toBe(4);
		expect(test.length).toBe(2);
		expect(cutoff).toBe("2026-10-21T10:05:00.000Z");
	});
});
