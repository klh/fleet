// hooks/bin/hub-admin-html.ts — W231 hub admin plane page (/console/hub):
// the console shell (consolePage) hosting the Lit admin surface. The page
// itself is chrome; all data UI is the klh-hub-admin web component
// (board-html/klh-hub-admin.ts → /vendor/klh-hub-admin.js), which talks to
// same-origin /api/hub/* (the board's write cookie rides automatically).
// No server-rendered data tables here — new UI is Lit per the UI
// engineering law (legacy string pages are W184 legacy).
import type { ConsoleMe } from "./console-html.ts";
import { consolePage } from "./console-html.ts";

export const hubPage = (me?: ConsoleMe): string =>
	consolePage(
		"Hub admin",
		"",
		`<style>.hubwrap{max-width:1000px}</style><p class="dimpl">Tokens, provider keys and federation for this hub — enforcement rides the identity layer (scoped, expiring bearer tokens) and every GUI mutation lands in the audit trail.</p><div class="hubwrap"><klh-hub-admin></klh-hub-admin></div>`,
		me,
	).replace(
		"</body>",
		`<script type="module" src="/vendor/klh-hub-admin.js"></script></body>`,
	);
