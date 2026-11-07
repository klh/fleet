// test/report-tab@unit.e2e.ts — W2550.3/W2847: the report family's URL
// contracts + the row-switch clear, as pure-unit pins (the feed-store.e2e
// idiom — no DOM; the mediator module imports clean outside a browser).
// Pins the retired REPORT chunk's projQuery/reportRowUrl shapes, now
// exported from the mediator: the pane's project query and the OPEN ROW's
// own-project-wins row URL. The clear() pin guards W2847's blocker — a
// row switch must drop the store's landed payload so the loading window
// renders instead of the previous row.
import { expect, test } from "@playwright/test";
import { FeedStore } from "../hooks/board-html/feed-store.ts";
import {
	reportQueryOf,
	reportRowUrlOf,
} from "../hooks/board-html/klh-report-mediator.ts";

test("the pane query is empty for the all-scope, encoded otherwise", () => {
	expect(reportQueryOf("all")).toBe("");
	expect(reportQueryOf("")).toBe("");
	expect(reportQueryOf("/repos/team/.git")).toBe(
		"?project=%2Frepos%2Fteam%2F.git",
	);
});

test("the row URL gates on the report tab and an open row", () => {
	expect(reportRowUrlOf("decisions", "W1", "all", "")).toBe("");
	expect(reportRowUrlOf("report", "", "all", "")).toBe("");
});

test("the open row's own project wins over the global filter", () => {
	// the pane payload's project is the fallback scope (all-scope filter)
	expect(reportRowUrlOf("report", "W1", "all", "/repos/pane/.git")).toBe(
		"/api/report-row?project=%2Frepos%2Fpane%2F.git&id=W1",
	);
	// an explicit filter beats the pane payload's own project
	expect(
		reportRowUrlOf("report", "W1", "/repos/filter/.git", "/repos/pane/.git"),
	).toBe("/api/report-row?project=%2Frepos%2Ffilter%2F.git&id=W1");
});

test("clear() drops a feed's landed payload without touching cadence", () => {
	const store = new FeedStore({
		fetch: () => new Promise(() => {}) as Promise<Response>,
		now: () => 1_000_000,
		random: () => 1,
		setTimer: null,
		clearTimer: null,
		hidden: () => false,
	});
	store.define("reportRow", { everyMs: 30_000, url: () => "/api/report-row" });
	// land a payload as the store itself would, then clear it
	const st = store.get("reportRow");
	expect(st).not.toBeNull();
	if (st) {
		st.data = { ok: true, id: "W1" };
		st.loaded = true;
	}
	store.clear("reportRow");
	const after = store.get("reportRow");
	expect(after).not.toBeNull();
	if (after) {
		expect(after.data).toBeNull();
		expect(after.loaded).toBe(false);
		expect(after.err).toBeNull();
	}
	// an unknown feed is a no-op, never a throw
	store.clear("nope");
});
