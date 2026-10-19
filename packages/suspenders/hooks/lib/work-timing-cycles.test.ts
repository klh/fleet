// W895 — ghost-clock cycle tests for workTiming + claimWindows. In-memory
// events, real replay. Release/supersede end the claim cycle: the clock
// measures the fresh claim's window; spent cycles stay kept (split).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	type ItemAttribution,
	renderAttribution,
	STALE_AGENT_MS,
} from "./lane-spend.ts";
import { claimWindows, workTiming } from "./work-timing.ts";

const PROJ = "/repo/.git";
const T0 = 1_700_000_000_000;
const D = 86_400_000;

function db(): Database {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL," +
			" source TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT, project TEXT)",
	);
	return d;
}

function ev(
	d: Database,
	kind: string,
	work: string,
	ts: number,
	by?: string,
): void {
	d.run(
		"INSERT INTO events (ts, source, kind, payload, project) VALUES (?, 'work', ?, ?, ?)",
		[ts, kind, JSON.stringify({ work, ...(by ? { by } : {}) }), PROJ],
	);
}

describe("workTiming W895 cycles", () => {
	test("released ghost cycle resets the clock and keeps prior", () => {
		const d = db();
		ev(d, "work.claimed", "W1", T0, "ghost-sid");
		ev(d, "work.released", "W1", T0 + 9 * D, "reclaim-all");
		const [t] = workTiming(d, PROJ, T0 + 10 * D);
		expect(t.wallMs).toBe(0);
		expect(t.agentMs).toBe(0);
		expect(t.firstClaim).toBe(0);
		expect(t.priorAgentMs).toBe(9 * D);
		expect(t.priorCycles).toBe(1);
		expect(t.priorSinceMs).toBe(T0);
		expect(t.running).toBe(false);
	});

	test("fresh claim opens a new window after the ghost release", () => {
		const d = db();
		ev(d, "work.claimed", "W1", T0, "ghost-sid");
		ev(d, "work.released", "W1", T0 + 9 * D, "reclaim-all");
		ev(d, "work.claimed", "W1", T0 + 9.5 * D, "fresh-sid");
		const [t] = workTiming(d, PROJ, T0 + 10 * D);
		const fresh = 0.5 * D;
		expect(t.wallMs).toBe(fresh);
		expect(t.agentMs).toBe(fresh);
		expect(t.firstClaim).toBe(T0 + 9.5 * D);
		expect(t.priorAgentMs).toBe(9 * D);
		expect(t.running).toBe(true);
	});

	test("supersede closes the segment and ends the cycle", () => {
		const d = db();
		ev(d, "work.claimed", "W1", T0, "s1");
		ev(d, "work.superseded", "W1", T0 + 7_200_000);
		const [t] = workTiming(d, PROJ, T0 + 8_000_000);
		expect(t.priorAgentMs).toBe(7_200_000);
		expect(t.priorCycles).toBe(1);
		expect(t.agentMs).toBe(0);
		const { windows } = claimWindows(d, PROJ, T0 + 8_000_000);
		expect((windows.get("W1") ?? [])[0]?.end).toBe(T0 + 7_200_000);
	});

	test("done keeps the final cycle; mid-life release stays kept", () => {
		const d = db();
		ev(d, "work.claimed", "W1", T0, "s1");
		ev(d, "work.released", "W1", T0 + 3_600_000);
		ev(d, "work.claimed", "W1", T0 + 7_200_000, "s2");
		ev(d, "work.done", "W1", T0 + 18_000_000);
		const [t] = workTiming(d, PROJ, T0 + 20_000_000);
		expect(t.wallMs).toBe(10_800_000);
		expect(t.agentMs).toBe(10_800_000);
		expect(t.priorAgentMs).toBe(3_600_000);
		expect(t.priorCycles).toBe(1);
	});
});

// W895 — the stale-clock report guard: agent time > 7d on a non-running
// item renders 'stale (pre-<date>)', never raw hours; kept prior cycles
// render bounded. Constructed attributions, real renderer.
describe("renderAttribution W895 stale guard", () => {
	const mk = (over: Partial<ItemAttribution>): ItemAttribution => ({
		work: "W9",
		fresh: 0,
		cached: 3_100,
		out: 950,
		requests: 3,
		wallMs: 0,
		agentMs: 0,
		firstClaimMs: 0,
		priorAgentMs: 0,
		priorCycles: 0,
		priorSinceMs: 0,
		groups: {},
		running: false,
		...over,
	});
	test("non-running agent > 7d renders stale, not raw hours", () => {
		const a = mk({
			agentMs: STALE_AGENT_MS + 3_600_000,
			wallMs: STALE_AGENT_MS + 3_600_000,
			firstClaimMs: T0,
		});
		const line = renderAttribution(a);
		expect(line.includes("stale (pre-")).toBe(true);
		expect(line.includes("agent 169h")).toBe(false);
	});
	test("running item renders raw agent hours", () => {
		const a = mk({
			agentMs: STALE_AGENT_MS + 3_600_000,
			wallMs: STALE_AGENT_MS + 3_600_000,
			firstClaimMs: T0,
			running: true,
		});
		expect(renderAttribution(a).includes("agent 169h")).toBe(true);
	});
	test("kept prior cycles render bounded when stale", () => {
		const a = mk({ priorAgentMs: 9 * D, priorCycles: 1, priorSinceMs: T0 });
		const line = renderAttribution(a);
		expect(line.includes("prior stale (pre-")).toBe(true);
		expect(line.includes("216h")).toBe(false);
	});
});
