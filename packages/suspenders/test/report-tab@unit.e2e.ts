import { expect, test } from "@playwright/test";
// W2550.3: the report family's URL contracts (the retired REPORT chunk's
// projQuery/reportRowUrl shapes, now exported from the mediator) — the
// pane's project query and the OPEN ROW's own-project-wins row URL.
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
	expect(reportRowUrlOf("report", "W1", "/repos/filter/.git", "/repos/pane/.git")).toBe(
		"/api/report-row?project=%2Frepos%2Ffilter%2F.git&id=W1",
	);
});
