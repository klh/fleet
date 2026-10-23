// hooks/board/routes-reports.ts — W1199 lane report artifacts: GET
// /api/report/<id>?project=<p> serves the single-file HTML view generated at
// close (work done --report). The graph records the artifact (a work.report
// event); the file is the regenerable view — a missing file 404s honestly.
// Serving lives in lib/report-html.ts (pure, fixture-db testable); this
// module is the live-db route wrapper.
import { serveReport } from "../lib/report-html.ts";
import { db } from "./context.ts";
import { json } from "./helpers.ts";

export async function handleReports(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method !== "GET") return null;
	const m = url.pathname.match(/^\/api\/report\/([^/]+)$/);
	if (!m?.[1]) return null;
	const id = decodeURIComponent(m[1]);
	const project = url.searchParams.get("project") ?? "";
	const served = serveReport(db, project, id);
	if (!served)
		return json(
			{
				ok: false,
				error:
					"no report artifact for this item (the HTML view is regenerable from the markdown record)",
			},
			404,
		);
	return served;
}
