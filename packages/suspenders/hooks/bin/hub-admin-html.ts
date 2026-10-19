// hooks/bin/hub-admin-html.ts — W231 hub admin plane page (/console/hub):
// the console shell (consolePage) hosting the Lit admin surface. W695.3.3:
// the page is chrome only — intro copy, layout (max-width) and all data UI
// live in the klh-hub-admin web component (board-html/klh-hub-admin.ts →
// /vendor/klh-hub-admin.js), which talks to same-origin /api/hub/* (the
// board's write cookie rides automatically). No page-level CSS or copy.
import type { ConsoleMe } from "./console-html.ts";
import { consolePage } from "./console-html.ts";

export const hubPage = (me?: ConsoleMe): string =>
	consolePage(
		"Hub admin",
		"hub",
		"<klh-hub-admin></klh-hub-admin>",
		me,
	).replace(
		"</body>",
		`<script type="module" src="/vendor/klh-hub-admin.js"></script></body>`,
	);
