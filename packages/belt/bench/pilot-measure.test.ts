// pilot-measure.test.ts — pure-logic tests for the W845 pilot measurement.
// No network, no ledger, no git: fixtures only (IO tails are thin on purpose).

import { describe, expect, test } from "bun:test";
import { accrete, buildSummary, classifyTitle, inWindow, pct, sidToItem, type DecisionRow, type LedgerRow, type TaskRow } from "./pilot-measure.ts";

describe("sidToItem", () => {
	test("maps dispatch lane sids to item ids", () => {
		expect(sidToItem("autow845-p98b319584008df14")).toBe("W845");
		expect(sidToItem("autow422-17-3")).toBe("W422");
		expect(sidToItem("codex-w528-probe")).toBe("W528");
		expect(sidToItem("codex-W505-verification")).toBe("W505");
	});

	test("returns null for unattributed keys", () => {
		expect(sidToItem("codex-audit-7baaf4c1-81aa")).toBeNull();
		expect(sidToItem("tooltest3")).toBeNull();
		expect(sidToItem("01a10cf6-6c39")).toBeNull();
		expect(sidToItem("")).toBeNull();
	});
});

describe("classifyTitle", () => {
	test("declared heuristic buckets", () => {
		expect(classifyTitle("fix regression in reclaim path")).toBe("fix");
		expect(classifyTitle("board payload batching")).toBe("ui");
		expect(classifyTitle("measure pilot output quality")).toBe("bench");
		expect(classifyTitle("install-grade seedLocalLlm steps")).toBe("install");
		expect(classifyTitle("quiesce the fleet")).toBe("other");
	});
});

describe("inWindow", () => {
	test("bounds and rejects null/unparseable", () => {
		const since = Date.parse("2026-10-06T00:00:00Z");
		const until = Date.parse("2026-10-19T00:00:00Z");
		expect(inWindow("2026-10-19T07:20:00.833Z", since, until)).toBe(false);
		expect(inWindow("2026-10-12T07:20:00.833Z", since, until)).toBe(true);
		expect(inWindow(null, since, until)).toBe(false);
		expect(inWindow("not-a-date", since, until)).toBe(false);
	});
});

describe("accrete", () => {
	const blank = () => ({
		id: "W1",
		title: "t",
		state: "DONE",
		parent_id: null,
		completed_at: null,
		workload: "other",
		tokens_in: 0,
		tokens_out: 0,
		tokens_cached: 0,
		requests: 0,
		wall_min: null,
		agent_min: null,
		source: "none" as const,
		groups: {},
	});

	test("graph spend fills wall + tokens and wins source", () => {
		const spend = {
			fresh: 10,
			cached: 0,
			out: 5,
			requests: 2,
			wall_ms: 120_000,
			agent_ms: 60_000,
			model_groups: { "glm-5.3-flash": { in: 10, out: 5, cacheR: 0, cacheC: 0, requests: 2 } },
		};
		const item = accrete(blank(), spend, undefined);
		expect(item.tokens_in).toBe(10);
		expect(item.tokens_out).toBe(5);
		expect(item.requests).toBe(2);
		expect(item.wall_min).toBe(2);
		expect(item.agent_min).toBe(1);
		expect(item.source).toBe("graph-spend");
		expect(item.groups["glm-5.3-flash"].requests).toBe(2);
	});

	test("ledger join adds tokens and marks ledger-join only from none", () => {
		const row: LedgerRow = { key_name: "autow1-x", model_group: "claude-sonnet-5", i: 100, o: 20, cr: 7, cc: 0, r: 3 };
		const item = accrete(accrete(blank(), null, undefined), null, row);
		expect(item.tokens_in).toBe(100);
		expect(item.tokens_cached).toBe(7);
		expect(item.requests).toBe(3);
		expect(item.source).toBe("ledger-join");
		expect(item.groups["claude-sonnet-5"].cacheR).toBe(7);
	});

	test("ledger join on top of graph spend keeps graph-spend source", () => {
		const spend = {
			fresh: 10,
			cached: 0,
			out: 5,
			requests: 2,
			wall_ms: 120_000,
			agent_ms: 60_000,
			model_groups: { "glm-5.3-flash": { in: 10, out: 5, cacheR: 0, cacheC: 0, requests: 2 } },
		};
		const row: LedgerRow = { key_name: "autow1-x", model_group: "claude-sonnet-5", i: 100, o: 20, cr: 0, cc: 0, r: 3 };
		const item = accrete(accrete(blank(), spend, undefined), null, row);
		expect(item.source).toBe("graph-spend");
		expect(item.tokens_in).toBe(110);
	});
});

describe("pct", () => {
	test("nearest-rank percentiles, null on empty", () => {
		expect(pct([5, 1, 9, 3, 7], 50)).toBe(5);
		expect(pct([1, 2, 3, 4], 90)).toBe(4);
		expect(pct([1, 2, 3, 4], 0)).toBe(1);
		expect(pct([], 50)).toBeNull();
	});
});

describe("buildSummary", () => {
	const task = (over: Partial<TaskRow>): TaskRow => ({
		project: "/repo/.git",
		id: "W1",
		title: "a title",
		state: "DONE",
		parent_id: null,
		tail: { ts: "2026-10-12T07:20:00.833Z", text: "landed" },
		spend: null,
		...over,
	});

	test("windows done items, aggregates groups, counts rework children and proxies", () => {
		const tasks: TaskRow[] = [
			task({ id: "W1", title: "fix the gate" }),
			task({ id: "W2", state: "FAILED" }),
			task({ id: "W3", state: "DONE", tail: { ts: "2026-01-01T00:00:00Z", text: "too old" } }),
			task({ id: "W9", title: "re-land the wing", state: "DONE", parent_id: "W1", tag: "re-land" }),
			task({ id: "W10", title: "deliberately-unrelated-title", state: "DONE", parent_id: "W1", tag: "fix" }),
			task({ id: "W11", title: "fix keyword bait", state: "DONE", parent_id: "W1" }),
		];
		const ledger: LedgerRow[] = [
			{ key_name: "autow1-x", model_group: "glm-5.3-flash", i: 500, o: 100, cr: 0, cc: 0, r: 4 },
			{ key_name: "autow9-x", model_group: "claude-sonnet-5", i: 200, o: 50, cr: 10, cc: 0, r: 2 },
			{ key_name: "codex-audit-nope", model_group: "glm-5.3-flash", i: 999, o: 999, cr: 0, cc: 0, r: 9 },
		];
		const { items, summary } = buildSummary(
			tasks,
			ledger,
			{ since: "2026-10-06T00:00:00Z", until: "2026-10-19T00:00:00Z" },
			"/repo/.git",
			{ merge_commits: 10, fleet_branch_merges: 7, insertions: 1000, deletions: 100 },
		);
		expect(items.map((i) => i.id).sort()).toEqual(["W1", "W10", "W11", "W9"]);
		expect(summary.items.done).toBe(4);
		expect(summary.items.with_tokens).toBe(2);
		expect(summary.items.failed_total).toBe(1);
		// W846: tag counter — tagged W9+W10 count, untagged fix-titled W11 does not
		expect(summary.items.rework_children).toBe(2);
		expect(summary.totals.tokens_in).toBe(700);
		expect(summary.totals.tokens_out).toBe(150);
		expect(summary.totals.requests).toBe(6);
		expect(summary.tokens.by_group["glm-5.3-flash"].in).toBe(500);
		expect(summary.tokens.by_group["claude-sonnet-5"].cacheR).toBe(10);
		expect(summary.acceptance.fleet_branch_merges).toBe(7);
		expect(summary.not_instrumented.length).toBe(3);
		expect(summary.uncertainty.some((u) => u.includes("no equivalence claim"))).toBe(true);
	});
});

describe("buildSummary human time (W846)", () => {
	const task = (over: Partial<TaskRow>): TaskRow => ({
		project: "/repo/.git",
		id: "W1",
		title: "a title",
		state: "DONE",
		parent_id: null,
		tail: { ts: "2026-10-12T07:20:00.833Z", text: "landed" },
		spend: null,
		...over,
	});
	const dec = (over: Partial<DecisionRow>): DecisionRow => ({
		id: 1,
		project: "/repo/.git",
		task_id: "W1",
		state: "ANSWERED",
		created_ts: Date.parse("2026-10-12T00:00:00Z"),
		answered_ts: Date.parse("2026-10-12T02:00:00Z"),
		ack_ts: null,
		...over,
	});

	test("settled decisions attribute per-item human time + latency percentiles", () => {
		const { items, summary } = buildSummary(
			[task({ id: "W1" })],
			[],
			{ since: "2026-10-06T00:00:00Z", until: "2026-10-19T00:00:00Z" },
			"/repo/.git",
			{ merge_commits: 0, fleet_branch_merges: 0, insertions: 0, deletions: 0 },
			[
				dec({ id: 1 }),
				dec({ id: 2, task_id: null }),
			],
		);
		// W1's decision settles 2h after the ask → 120 min; the unattributed
		// fork (task_id null) counts in totals but attributes to no item
		expect(items[0]?.human_time_min).toBe(120);
		expect(summary.human.settled).toBe(2);
		expect(summary.human.decisions_in_window).toBe(2);
		expect(summary.human.items_with_human_time).toBe(1);
		expect(summary.human.latency_min_p50).toBe(120);
	});
});
