// test/board-status-badge.test.ts — W998.1: the kanban status badge is a
// corner tab whose outline sits ON the card's top and left border. The
// geometry is proven live by e2e/board-status-badge.spec.ts (measured
// rects); this pins the shipped CSS contract so the rule can't drift.
import { expect, test } from "./pw";
import { HTML } from "../hooks/bin/fleet-board-html.ts";

test.describe("status badge corner-tab CSS (W998.1)", () => {
	test("badge pins to the row top — centering may not push it off the border", () => {
		expect(HTML).toMatch(/\.krow \.pill \{[^}]*align-self:flex-start/);
	});

	test("badge top border overlays the card's (row has no top padding)", () => {
		expect(HTML).toMatch(/\.krow \.pill \{[^}]*margin:-1px 0 0 0;/);
	});

	test("badge left border overlays the card's — the row's -13px margin already reaches the border's outer edge", () => {
		expect(HTML).toMatch(/\.krow \{[^}]*margin:0 -12px 0 -13px;/);
	});
});
