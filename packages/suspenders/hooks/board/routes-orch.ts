// hooks/board/routes-orch.ts — W57 orchestrate endpoints (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { DEMO } from "./context.ts";
import { json, writeGuard, readJson } from "./helpers.ts";
import { ORCH, orchestrate, orchPrepare, orchRegister } from "./orch.ts";
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
} from "../lib/board-config.ts";

const promptSettings = (): PromptSettings =>
	resolvePromptSettings(readBoardSettings().settings);
const wantsPreview = (s: PromptSettings): boolean =>
	s["prompt.debug"] || s["prompt.log"];

export async function handleOrch(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/prompt/settings") {
		// W270 — the orchestrate prompt-transform toggles (suspenders-board.json)
		if (req.method === "GET")
			return json({ ok: true, settings: promptSettings() });
		if (req.method !== "POST") return null;
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const patch: Partial<PromptSettings> = {};
		for (const k of PROMPT_KEYS) {
			const v = parsed.body?.[k];
			if (v === undefined) continue;
			if (typeof v !== "boolean")
				return json({ ok: false, error: `${k}: must be true or false` }, 400);
			patch[k] = v;
		}
		try {
			applyBoardSettings(boardSettingsPath(), patch);
		} catch (e) {
			if (e instanceof ConfigError)
				return json({ ok: false, error: e.message }, 400);
			throw e;
		}
		return json({ ok: true, settings: promptSettings() });
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
		const p = await orchPrepare(project, goal);
		if (!p.ok) return json({ ok: false, error: p.error }, p.status);
		const previewId = holdPlan({
			project,
			goal,
			final: p.plan.final,
			ctx: p.ctx,
		});
		return json({ ok: true, previewId, preview: previewView(p.plan) });
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
			const r = await orchestrate(project, held.final, { ctx: held.ctx });
			return json({ ...r.body, previewed: true }, r.status);
		}
		const p = await orchPrepare(project, goal);
		if (!p.ok) return json({ ok: false, error: p.error }, p.status);
		const r = await orchestrate(project, p.plan.final, { ctx: p.ctx });
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
		const r = orchRegister(project, title, kids);
		return json(r.body, r.status);
	}
	// ── W147 console (NEW paths only; existing routes untouched) ──
	return null;
}
