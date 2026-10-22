// hooks/board/routes-reports.ts — W1199 lane report artifacts: GET
// /api/report/<id>?project=<p> serves the single-file HTML view generated at
// close (work done --report). The graph records the artifact (a work.report
// event); the file is the regenerable view — a missing file 404s honestly.
import { existsSync, readFileSync } from "node:fs";
import { projectRootOf } from "../lib/govdb-project.ts";
import {
	reportArtifactPath,
	reportRecordFor,
} from "../lib/report-html.ts";
import { db } from "./context.ts";
import { json } from "./helpers.ts";

// Pure over the db handle so fixture-db tests call it directly. The artifact
// path is DERIVED (never taken from the event payload) — a report route can
// only ever serve the item's own .fleet/reports/<id>.html.
export function serveReport(
	gov: Parameters<typeof reportRecordFor>[0],
	project: string,
	id: string,
): Response | null {
	if (!project || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
	const rec = reportRecordFor(gov, project, id);
	if (!rec) return null;
	const path = reportArtifactPath(projectRootOf(project), id);
	if (!existsSync(path)) return null;
	const headers: Record<string, string> = {
		"content-type": "text/html; charset=utf-8",
		"x-content-type-options": "nosniff",
		"cache-control": "no-store",
	};
	try {
		return new Response(readFileSync(path, "utf8"), { headers: headers });
	} catch {
		return null;
	}
}

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

