// hooks/board/routes-orch.ts — W57 orchestrate endpoints (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { DEMO } from "./context.ts";
import {
	etagOf,
	idempotentRespond,
	IdempotencyStore,
	ifMatchMissing,
	ifMatchState,
	problemOf,
	RouteTable,
	toProblemResponse,
} from "@klh/buckle/src/http-kit.ts";
import { json, writeGuard, readJson } from "./helpers.ts";
import { ORCH, orchestrate, orchPrepare, orchRegister } from "./orch.ts";
import { newOrchTraceId, recordOrchStep } from "./orch-trace.ts";
import { composeGoalAttachments } from "./drop-files.ts";
import {
	holdPlan,
	PROMPT_KEYS,
	type PromptSettings,
	previewView,
	resolvePromptSettings,
	takePlan,
} from "./prompt-transform.ts";
import {
	applyBoardSettings,
	boardSettingsPath,
	ConfigError,
	readBoardSettings,
} from "../lib/board/board-config.ts";

const promptSettings = (): PromptSettings =>
	resolvePromptSettings(readBoardSettings().settings);
const wantsPreview = (s: PromptSettings): boolean =>
	s["prompt.debug"] || s["prompt.log"];
// W858.8 — attachment refs ride the preview/dispatch bodies; each is
// resolved fresh (dead ref = 400) and composed as a prompt block
const attachmentsOf = (body: Record<string, unknown> | undefined): string[] =>
	Array.isArray(body?.attachments)
		? (body.attachments as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: [];

const settingsIdempotency = new IdempotencyStore({ ttlS: 3600 });

const settingsTable = new RouteTable(
	[
		{
			method: "GET",
			pattern: "/api/prompt/settings",
			handler: (): Response => {
				const settings = promptSettings();
				return json({ ok: true, settings, etag: etagOf(settings) });
			},
		},
		{
			method: "POST",
			pattern: "/api/prompt/settings",
			handler: ({ req, url }): Response | Promise<Response> => {
				const guard = writeGuard(req, url);
				if (guard) return guard;
				return idempotentRespond(settingsIdempotency, req, (r) =>
					applySettings(r, url),
				);
			},
		},
	],
	{ service: "board" },
);

/** W1303.2 — the settings write semantics: W264 perimeter (writeGuard at the
 *  route), conditional (If-Match required — 428 missing, 412 stale), 422
 *  with field errors on non-boolean patches, idempotent (key+body bound). */
async function applySettings(req: Request, url: URL): Promise<Response> {
	if (ifMatchMissing(req.headers))
		return toProblemResponse(
			problemOf("precondition_required", {
				code: "board.if_match_required",
				why: "settings writes require If-Match (GET returns the etag)",
				instance: url.pathname,
			}),
		);
	if (ifMatchState(req.headers, etagOf(promptSettings())) === "mismatch")
		return toProblemResponse(
			problemOf("precondition_failed", {
				code: "board.settings_stale",
				why: "settings changed since the etag was read",
				instance: url.pathname,
			}),
		);
	const parsed = await readJson(req);
	if (!parsed.ok) return parsed.resp;
	const patch: Partial<PromptSettings> = {};
	for (const k of PROMPT_KEYS) {
		const v = parsed.body?.[k];
		if (v === undefined) continue;
		if (typeof v !== "boolean")
			return toProblemResponse(
				problemOf("validation", {
					code: "board.settings_invalid",
					why: "settings values must be booleans",
					instance: url.pathname,
					fields: [{ field: k, why: "must be true or false" }],
				}),
			);
		patch[k] = v;
	}
	try {
		applyBoardSettings(boardSettingsPath(), patch);
	} catch (e) {
		if (e instanceof ConfigError)
			return toProblemResponse(
				problemOf("validation", {
					code: "board.settings_invalid",
					why: e.message,
					instance: url.pathname,
				}),
			);
		throw e;
	}
	const applied = promptSettings();
	return json({ ok: true, settings: applied, etag: etagOf(applied) });
}

export async function handleOrch(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/prompt/settings") {
		// W270 toggles; W1303.2 — routed by the kit table: HEAD/OPTIONS
		// automatic, 405+Allow, 428/412 conditionals, idempotent replay.
		return settingsTable.serve(req, url);
	}
	if (req.method === "POST" && url.pathname === "/api/orchestrate/preview") {
		// W270 — what WILL be dispatched: transforms run (enhance may call the
		// :4000 router), no plan LLM call, zero work-graph writes. Secrets are
		// redacted in the view; the exact plan is held for the dispatch.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const goal = String(parsed.body?.goal ?? "")
			.trim()
			.slice(0, ORCH.GOAL_MAX);
		if (!project || !goal)
			return json({ ok: false, error: "missing project or goal" }, 400);
		const att = attachmentsOf(parsed.body);
		const composed = composeGoalAttachments(goal, att);
		if (!composed.ok) return json({ ok: false, error: composed.error }, 400);
		const traceId = newOrchTraceId();
		recordOrchStep(project, {
			traceId,
			at: Date.now(),
			phase: "request.accepted",
			service: "board",
			status: "ok",
		});
		const p = await orchPrepare(project, composed.goal, traceId);
		if (!p.ok) return json({ ok: false, error: p.error }, p.status);
		const previewId = holdPlan({
			project,
			goal,
			traceId,
			final: p.plan.final,
			ctx: p.ctx,
		});
		return json({ ok: true, traceId, previewId, preview: previewView(p.plan) });
	}
	if (req.method === "POST" && url.pathname === "/api/orchestrate") {
		// W57 — propose only: an LLM round-trip, zero work-graph writes.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const goal = String(parsed.body?.goal ?? "")
			.trim()
			.slice(0, ORCH.GOAL_MAX);
		if (!project || !goal)
			return json({ ok: false, error: "missing project or goal" }, 400);
		// W270 — a previewed plan dispatches verbatim; otherwise transform now
		const pid = parsed.body?.previewId;
		const held = typeof pid === "string" ? takePlan(pid, project, goal) : null;
		if (held) {
			const r = await orchestrate(
				project,
				held.final,
				{ ctx: held.ctx },
				held.traceId,
			);
			return json({ ...r.body, previewed: true }, r.status);
		}
		const att = attachmentsOf(parsed.body);
		const composed = composeGoalAttachments(goal, att);
		if (!composed.ok) return json({ ok: false, error: composed.error }, 400);
		const traceId = newOrchTraceId();
		recordOrchStep(project, {
			traceId,
			at: Date.now(),
			phase: "request.accepted",
			service: "board",
			status: "ok",
		});
		const p = await orchPrepare(project, composed.goal, traceId);
		if (!p.ok) return json({ ok: false, error: p.error }, p.status);
		const r = await orchestrate(project, p.plan.final, { ctx: p.ctx }, traceId);
		const view = wantsPreview(p.plan.settings)
			? { prompt: previewView(p.plan) }
			: {};
		return json({ ...r.body, ...view }, r.status);
	}
	if (req.method === "POST" && url.pathname === "/api/orchestrate/register") {
		// W57 — the one click: register the proposal as a plan item + a
		// plan-gated split via the work CLI in the target repo.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const title = String(parsed.body?.title ?? "")
			.trim()
			.slice(0, ORCH.TITLE_MAX);
		const raw = Array.isArray(parsed.body?.children)
			? (parsed.body.children as unknown[])
			: [];
		const kids = raw
			.map((c) =>
				typeof c === "string"
					? c.trim().slice(0, ORCH.TITLE_MAX)
					: typeof (c as { title?: unknown })?.title === "string"
						? String((c as { title?: unknown }).title)
								.trim()
								.slice(0, ORCH.TITLE_MAX)
						: "",
			)
			.filter((t) => t.length > 0);
		if (!project) return json({ ok: false, error: "missing project" }, 400);
		if (!title) return json({ ok: false, error: "missing title" }, 400);
		if (kids.length < ORCH.MIN_CHILDREN || kids.length > ORCH.MAX_CHILDREN)
			return json({ ok: false, error: "children must number 2..8" }, 400);
		const requestedTraceId = parsed.body?.traceId;
		const traceId =
			typeof requestedTraceId === "string" &&
			/^[0-9a-f]{32}$/.test(requestedTraceId)
				? requestedTraceId
				: newOrchTraceId();
		const r = orchRegister(project, title, kids, traceId);
		return json(r.body, r.status);
	}
	// ── W147 console (NEW paths only; existing routes untouched) ──
	return null;
}
