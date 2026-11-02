// hooks/board/retry-action.ts — W2267.3: the recovery-action core shared by
// /api/retry (recover + fresh attempt) and /api/recover (requeue only).
// The operator gate and item checks are the W970 contract, extracted verbatim
// so both verbs share ONE implementation — never two labeled calls to the
// same verb (the owner's distinct-actions ruling). Retry's dispatch leg rides
// the exact /api/start path (dispatchStart): claim, carrier selection,
// admission — a second ad-hoc state machine is banned by the item brief.
import { existsSync } from "node:fs";
import { projectRootOf } from "../lib/govdb/govdb.ts";
import { z } from "zod";
import { DEMO, db, WORK_CLI } from "./context.ts";
import { dispatchStart } from "./dispatch-core.ts";
import { runCli } from "./exec.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import { syncDecisions } from "./lanes.ts";

// W2267.3 schema law: the touched wire bodies parse through named shapes —
// a malformed body 400s loud (prettified), never a silent String() coerce.
export const RetryRequestSchema = z.object({
	project: z.string().min(1),
	id: z.string().min(1),
	force: z.boolean().optional().default(false),
	note: z.string().max(2000).optional().default(""),
	agent: z.string().optional(),
	effort: z.string().optional(),
});
export type RetryRequest = z.infer<typeof RetryRequestSchema>;

export const RecoverRequestSchema = RetryRequestSchema.omit({
	agent: true,
	effort: true,
}).strict(); // new wire: dispatch-only keys on a recover body are a loud 400
export type RecoverRequest = z.infer<typeof RecoverRequestSchema>;

// The operator-gated class (W970): an open NEED_DECISION on the item or the
// `operator` classification tag. Refuses with {operatorGated:true} so the
// card can offer a force confirm; null = proceed.
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

/** Shared pre-flight: write guard, schema parse, item + operator checks.
 *  Returns the request context or the refusal Response. */
export async function recoveryPreflight(
	req: Request,
	url: URL,
	schema: typeof RetryRequestSchema | typeof RecoverRequestSchema,
): Promise<
	{ ok: true; req: RetryRequest; repo: string } | { ok: false; resp: Response }
> {
	const guard = writeGuard(req, url);
	if (guard) return { ok: false, resp: guard };
	const parsed = await readJson(req);
	if (!parsed.ok) return { ok: false, resp: parsed.resp };
	const shape = schema.safeParse(parsed.body);
	if (!shape.success)
		return {
			ok: false,
			resp: json({ ok: false, error: z.prettifyError(shape.error) }, 400),
		};
	const body = shape.data as RetryRequest;
	if (DEMO)
		return {
			ok: false,
			resp: json({ ok: false, error: "demo board — no real lanes" }, 409),
		};
	const w = db
		.query("SELECT state, tags FROM work_items WHERE project = ? AND id = ?")
		.get(body.project, body.id) as {
		state: string;
		tags: string | null;
	} | null;
	if (!w)
		return {
			ok: false,
			resp: json(
				{ ok: false, error: `no work item ${body.id} in ${body.project}` },
				404,
			),
		};
	const gate = retryOperatorGate(body.project, body.id, w.tags, body.force);
	if (gate) return { ok: false, resp: gate };
	const repo = projectRootOf(body.project);
	if (!existsSync(repo))
		return {
			ok: false,
			resp: json(
				{ ok: false, error: `project directory missing: ${repo}` },
				409,
			),
		};
	return { ok: true, req: body, repo };
}

/** The canonical requeue leg (verbatim W970 semantics): `work retry` via the
 *  CLI — the verb owns state refusals, stale-claim release, budget reset. */
export function requeueLeg(
	body: { project: string; id: string; note?: string },
	repo: string,
): Response | null {
	const note = String(body.note ?? "")
		.trim()
		.slice(0, 2000);
	const retry = runCli(
		[WORK_CLI, "retry", body.id, ...(note ? ["--note", note] : [])],
		repo,
	);
	if (retry.code !== 0)
		return json(
			{ ok: false, error: `retry failed: ${retry.out.slice(0, 300)}` },
			409,
		);
	return null;
}

/** Reported state is READ BACK from the row, never assumed — a requeued
 *  item can be CLAIMED already by the time the response renders (the
 *  scheduler/fresh-attempt race); "READY" is only the fallback when the
 *  row vanished mid-request. */
export function itemStateOf(project: string, id: string): string {
	return String(
		(
			db
				.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
				.get(project, id) as { state: string } | null
		)?.state ?? "READY",
	);
}

/** Previous-executor preservation (W2267.3): a retry without an explicit
 *  agent re-rides the executor the dead lane launched with. Runs BEFORE the
 *  requeue — `work retry` clears owner_sid, so the live claim row is the
 *  first source; terminal rows (owner already null) fall back to the newest
 *  work.claimed payload (`by` — the canonical retained attempt record,
 *  stamped by assignTask in work-alloc.ts). Model routing stays on the
 *  routing plane (.prefer/.must ride the chain); unknown tokens fall back
 *  to the claude carrier. */
export function previousExecutorOf(project: string, id: string): string | null {
	const w = db
		.query("SELECT owner_sid FROM work_items WHERE project = ? AND id = ?")
		.get(project, id) as { owner_sid: string | null } | null;
	const claimed = payloadOf(
		(
			db
				.query(
					"SELECT payload FROM events WHERE kind = 'work.claimed' AND project = ? AND work = ? ORDER BY id DESC LIMIT 1",
				)
				.get(project, id) as { payload: string | null } | null
		)?.payload,
	);
	const sid = w?.owner_sid ?? (claimed.by as string | undefined) ?? null;
	if (!sid) return null;
	const fact = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${sid}.executor`) as { value: string } | null;
	const token = fact?.value?.trim() ?? "";
	return token || null;
}

function payloadOf(raw: string | null | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** W2267.3 Retry = recovery + a fresh attempt: requeue, then the same
 *  /api/start dispatch path. A dispatch failure is SURFACED, never hidden —
 *  the item stays truthfully READY and the operator sees the exact outcome.
 *  `dispatch` is injectable so hermetic tests map responses without a spawn. */
export async function retryWithAttempt(
	body: RetryRequest,
	repo: string,
	dispatch: typeof dispatchStart = dispatchStart,
): Promise<Response> {
	// capture BEFORE the requeue — it clears owner_sid (root blocker 1)
	const prev = body.agent ?? previousExecutorOf(body.project, body.id);
	const refused = requeueLeg(body, repo);
	if (refused) return refused;
	const res = await dispatch(
		body.project,
		body.id,
		prev ?? "claude",
		body.effort ?? "",
	);
	const dispatchBody = (await res.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	// reported state is READ BACK from the row, never assumed (blocker 2)
	const state = itemStateOf(body.project, body.id);
	if (!dispatchBody.ok)
		return json(
			{
				ok: true,
				item: body.id,
				state,
				dispatched: false,
				dispatchError: String(dispatchBody.error ?? "dispatch failed"),
			},
			200,
		);
	return json({
		ok: true,
		item: body.id,
		state,
		dispatched: true,
		...(dispatchBody.sid ? { sid: dispatchBody.sid } : {}),
		...(dispatchBody.executor ? { executor: dispatchBody.executor } : {}),
		...(dispatchBody.claimToken ? { claimToken: dispatchBody.claimToken } : {}),
	});
}
