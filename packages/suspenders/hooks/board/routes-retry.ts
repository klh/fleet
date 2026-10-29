// hooks/board/routes-retry.ts — W970: /api/retry, the board face for the
// W761 `work retry` requeue verb (FAILED / budget-quarantined READY → READY).
// The CLI leg owns the state refusals verbatim; the operator gate runs first.
import { existsSync } from "node:fs";
import { projectRootOf } from "../lib/govdb/govdb.ts";
import { DEMO, db, WORK_CLI } from "./context.ts";
import { runCli } from "./exec.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import { syncDecisions } from "./lanes.ts";

// The operator-gated class is an open NEED_DECISION on the item (the W896
// verdict-repeat class) or the `operator` classification tag. Refuses with
// {operatorGated:true} so the card can offer a force confirm; null = proceed.
function retryOperatorGate(
	project: string,
	id: string,
	tags: string | null,
	force: boolean,
): Response | null {
	if (force) return null;
	syncDecisions({ force: true });
	const open = db
		.query(
			"SELECT event_id FROM decisions WHERE project = ? AND task_id = ? AND state = 'OPEN' LIMIT 1",
		)
		.get(project, id) as { event_id: number } | null;
	const tagged = String(tags ?? "")
		.split(",")
		.includes("operator");
	if (!open && !tagged) return null;
	return json(
		{
			ok: false,
			operatorGated: true,
			error: open
				? `${id} has an open NEED_DECISION (#${open.event_id}) — operator-gated requeue; force overrides`
				: `${id} carries the operator tag — retry would re-arm auto-dispatch for owner-only work; force overrides`,
		},
		409,
	);
}

export async function handleRetryActions(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method !== "POST" || url.pathname !== "/api/retry") return null;
	const guard = writeGuard(req, url);
	if (guard) return guard;
	const parsed = await readJson(req);
	if (!parsed.ok) return parsed.resp;
	const project = String(parsed.body?.project ?? "");
	const id = String(parsed.body?.id ?? "");
	const force = !!parsed.body?.force;
	const note = String(parsed.body?.note ?? "")
		.trim()
		.slice(0, 2000);
	if (!project || !id)
		return json({ ok: false, error: "missing project or id" }, 400);
	if (DEMO)
		return json({ ok: false, error: "demo board — no real lanes" }, 409);
	const w = db
		.query("SELECT state, tags FROM work_items WHERE project = ? AND id = ?")
		.get(project, id) as { state: string; tags: string | null } | null;
	if (!w)
		return json({ ok: false, error: `no work item ${id} in ${project}` }, 404);
	const gate = retryOperatorGate(project, id, w.tags, force);
	if (gate) return gate;
	const repo = projectRootOf(project);
	if (!existsSync(repo))
		return json(
			{ ok: false, error: `project directory missing: ${repo}` },
			409,
		);
	const retry = runCli(
		[WORK_CLI, "retry", id, ...(note ? ["--note", note] : [])],
		repo,
	);
	if (retry.code !== 0)
		return json(
			{ ok: false, error: `retry failed: ${retry.out.slice(0, 300)}` },
			409,
		);
	return json({ ok: true, item: id, state: "READY" });
}
