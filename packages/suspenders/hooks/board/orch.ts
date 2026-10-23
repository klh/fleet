// hooks/board/orch.ts — W57 orchestrate: LLM plan proposal + registration (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { CLI, db } from "./context.ts";
import { existsSync, readdirSync } from "node:fs";
import { readBoardSettings } from "../lib/board-config.ts";
import { buckleChat } from "../lib/inference-buckle.ts";
import {
	byteLen,
	enhancePrompt,
	type PromptPlan,
	preparePrompt,
	resolveEnhanceTarget,
	resolvePromptSettings,
} from "./prompt-transform.ts";
import { condenseTier } from "@klh/blam/src/condense/tiers.ts";
import { projectIdentity, projectRootOf } from "../lib/govdb.ts";
import {
	linkOrchWork,
	linkedOrchWork,
	orchTraceparent,
	recordOrchStep,
} from "./orch-trace.ts";

export const ORCH = {
	MIN_CHILDREN: 2,
	MAX_CHILDREN: 8,
	TITLE_MAX: 120,
	BRIEF_MAX: 400,
	GOAL_MAX: 2000,
	CTX_ITEMS: 40,
	CTX_ENTRIES: 60,
};

// W1119: the plan leg rides the shared Buckle client — model preference is
// data (SUSPENDERS_ORCH_MODEL, hint 'prefer local coder'), never an endpoint
// pin; the gate + scoped key resolve fail-closed at call time.
export const ORCH_MODEL = process.env.SUSPENDERS_ORCH_MODEL ?? "local-coder";
export const ORCH_HINT = "prefer local coder";
export const ORCH_HOST = "buckle";
export async function orchModelResolve(): Promise<string> {
	return ORCH_MODEL;
}
/** env seam for the gated leg — tests substitute a stub credential pair */
export const orchEnv = process.env;
export const ORCH_SYS = `You propose work decompositions for a coding-agent fleet. From the goal and repo context, output STRICT JSON only — no prose, no markdown fences:
{"title": "<plan title, imperative, <=120 chars>", "children": [{"title": "<child task title, imperative, independently actionable, <=120 chars>", "brief": "<one sentence of scope guidance, <=400 chars>"}]}
Rules: 2-6 children; children run in parallel — no shared-file edits, no ordering between them; never invent ids.`;

export interface OrchProposal {
	title: string;
	children: { title: string; brief: string }[];
}

// tolerate the failure modes local models actually produce: <think> blocks,
// markdown fences, prose around the object. Returns null when nothing
// proposal-shaped survives — the endpoint answers 502 and the human retries.
export function parseProposal(text: string): OrchProposal | null {
	const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const start = noThink.indexOf("{");
	const end = noThink.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let j: unknown;
	try {
		j = JSON.parse(noThink.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof j !== "object" || j === null) return null;
	const o = j as Record<string, unknown>;
	if (typeof o.title !== "string" || !Array.isArray(o.children)) return null;
	const kids: { title: string; brief: string }[] = [];
	for (const c of o.children) {
		if (typeof c !== "object" || c === null) continue;
		const co = c as Record<string, unknown>;
		const t =
			typeof co.title === "string"
				? co.title.trim().slice(0, ORCH.TITLE_MAX)
				: "";
		const b =
			typeof co.brief === "string"
				? co.brief.trim().slice(0, ORCH.BRIEF_MAX)
				: "";
		if (t) kids.push({ title: t, brief: b });
	}
	const title = o.title.trim().slice(0, ORCH.TITLE_MAX);
	if (!title || kids.length < ORCH.MIN_CHILDREN) return null;
	return { title, children: kids.slice(0, ORCH.MAX_CHILDREN) };
}

// bounded repo context: open work items (dedupe vs the goal is the model's
// job) + top-level entries as a cheap shape hint. W367.4: this is a
// machine-facing inbound context injection — the orchestrator LLM reads it,
// users see only the redacted preview disclosure — so the blam `machine`
// tier runs at consume-time (aggressive minus hedge removal: item titles
// keep hedges/scope words per law L2; paths/flags/dotted ids stay verbatim
// via the union protect grammar). Deterministic (L6), so the preview's
// disclosed ctx is byte-identical to the dispatched ctx — the held plan
// materializes ctx once, no tier-keyed cache needed.
export function orchContext(_project: string, repo: string): string {
	const items = (
		db
			.query(
				"SELECT id, state, title FROM work_items WHERE project = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED','SHATTERED') ORDER BY id LIMIT ?",
			)
			.all(projectIdentity(repo), ORCH.CTX_ITEMS) as {
			id: string;
			state: string;
			title: string;
		}[]
	)
		.map((r) => `- ${r.id} ${r.state}: ${r.title}`)
		.join("\n");
	const entries = readdirSync(repo)
		.filter((e) => e !== ".git" && e !== "node_modules")
		.sort()
		.slice(0, ORCH.CTX_ENTRIES)
		.join(", ");
	return condenseTier(
		"machine",
		`OPEN WORK ITEMS:\n${items || "(none)"}\nTOP-LEVEL: ${entries}`,
	).text;
}

// one llm.call telemetry event per orchestrate round-trip, success or not —
// the routing log shows failed calls too (advise.ts W28 pattern)
export function orchTelemetry(payload: Record<string, unknown>): void {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'orchestrate', 'llm.call', NULL, ?, NULL)",
	).run(Date.now(), JSON.stringify(payload));
}

// the exact user message on the wire — the preview discloses this append
export const orchUserMessage = (goal: string, ctx: string): string =>
	`GOAL:\n${goal}\n\nREPO CONTEXT:\n${ctx}`;

// W270 — run the prompt transforms for one orchestrate goal; the plan's
// ctx is pinned so dispatch sends exactly what the preview disclosed
export async function orchPrepare(
	project: string,
	goal: string,
	traceId?: string,
): Promise<
	| { ok: true; plan: PromptPlan; ctx: string }
	| { ok: false; status: number; error: string }
> {
	const repo = projectRootOf(project);
	if (!existsSync(repo))
		return {
			ok: false,
			status: 404,
			error: `project directory missing: ${repo}`,
		};
	const ctx = orchContext(project, repo);
	const settings = resolvePromptSettings(readBoardSettings().settings);
	const target = await resolveEnhanceTarget();
	const plan = await preparePrompt(goal, settings, {
		enhance: async (text) => {
			const r = await enhancePrompt(text, {
				model: target.model,
				...(traceId ? { traceparent: orchTraceparent(traceId) } : {}),
			});
			orchTelemetry({
				for: "prompt.enhance",
				traceId,
				project: projectIdentity(repo),
				model: r.model,
				host: "buckle",
				ms: r.ms,
				...(r.ok ? {} : { error: r.note.slice(0, 200) }),
			});
			if (traceId)
				recordOrchStep(project, {
					traceId,
					at: Date.now(),
					phase: "prompt.enhance",
					service: "buckle gateway",
					status: r.ok ? "ok" : "error",
					model: r.model,
					endpoint: "buckle",
					ms: r.ms,
				});
			return r;
		},
		injections: [
			{ label: "goal header (prepended)", text: "GOAL:\n" },
			{ label: "system prompt (orchestrator instructions)", text: ORCH_SYS },
			{
				label: "repo context (open work items + top-level entries)",
				text: `\n\nREPO CONTEXT:\n${ctx}`,
			},
		],
		compose: (final) => orchUserMessage(final, ctx),
	});
	if (traceId)
		recordOrchStep(project, {
			traceId,
			at: Date.now(),
			phase: "prompt.ready",
			service: "board",
			status: "ok",
		});
	// W894: durable condense stage bytes — content-free byte counts only,
	// feeding the report-savings fleet-day condense term (report-savings.ts).
	orchTelemetry({
		for: "prompt.stages",
		...(traceId ? { traceId } : {}),
		originalBytes: byteLen(plan.original),
		condensedBytes: plan.condensed === null ? null : byteLen(plan.condensed),
		enhancedBytes: plan.enhanced === null ? null : byteLen(plan.enhanced),
		finalBytes: byteLen(plan.final),
		wireBytes: byteLen(plan.wire),
	});
	return { ok: true, plan, ctx };
}

export async function orchestrate(
	project: string,
	goal: string,
	prepared?: { ctx: string },
	traceId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const repo = projectRootOf(project);
	if (!existsSync(repo))
		return {
			status: 404,
			body: { ok: false, error: `project directory missing: ${repo}` },
		};
	const ctx = prepared?.ctx ?? orchContext(project, repo);
	const t0 = Date.now();
	const model = await orchModelResolve();
	let content = "";
	let pt = 0;
	let ct = 0;
	let tt = 0;
	let llmError: string | null = null;
	try {
		// W1119: the one gated leg — fail closed on a down gate / absent key.
		const r = await buckleChat(
			{
				model,
				system: ORCH_SYS,
				user: orchUserMessage(goal, ctx),
				maxTokens: 1200,
				temperature: 0.2,
				hint: ORCH_HINT,
				...(traceId ? { traceparent: orchTraceparent(traceId) } : {}),
			},
			orchEnv,
		);
		content = r.text;
		pt = r.pt;
		ct = r.ct;
		tt = pt + ct;
	} catch (e) {
		llmError = e instanceof Error ? e.message : String(e);
	}
	orchTelemetry({
		for: "orchestrate",
		traceId,
		project: projectIdentity(repo),
		model,
		host: ORCH_HOST,
		pt,
		ct,
		tt,
		ms: Date.now() - t0,
		...(llmError ? { error: llmError.slice(0, 200) } : {}),
	});
	if (traceId)
		recordOrchStep(project, {
			traceId,
			at: Date.now(),
			phase: llmError ? "model.failed" : "model.completed",
			service: "local model",
			status: llmError ? "error" : "ok",
			model,
			endpoint: ORCH_HOST,
			ms: Date.now() - t0,
			inputTokens: pt,
			outputTokens: ct,
		});
	if (llmError)
		return {
			status: 502,
			body: { ok: false, traceId, error: llmError.slice(0, 300) },
		};
	const proposal = parseProposal(content);
	if (!proposal) {
		if (traceId)
			recordOrchStep(project, {
				traceId,
				at: Date.now(),
				phase: "model.output_rejected",
				service: "board",
				status: "error",
				model,
			});
		return {
			status: 502,
			body: {
				ok: false,
				traceId,
				error:
					"orchestrator returned no parseable plan (want JSON {title, children[]}) — rephrase the goal and retry",
			},
		};
	}
	return {
		status: 200,
		body: { ok: true, traceId, proposal, model, ms: Date.now() - t0 },
	};
}

// register: plan item first, then the plan-gated split — the plan item IS
// the split parent (AGENTS.md flow). Children ids are read back from the
// work graph, not parsed out of CLI prose (lesson.silent-noop-mutations).
export function orchRegister(
	project: string,
	title: string,
	kids: string[],
	traceId?: string,
): { status: number; body: Record<string, unknown> } {
	const repo = projectRootOf(project);
	if (!existsSync(repo))
		return {
			status: 404,
			body: { ok: false, error: `project directory missing: ${repo}` },
		};
	if (traceId) {
		const prior = linkedOrchWork(project, traceId);
		if (prior) {
			const children = db
				.query(
					"SELECT id,title FROM work_items WHERE project = ? AND parent_id = ? ORDER BY id",
				)
				.all(projectIdentity(repo), prior) as { id: string; title: string }[];
			return {
				status: 200,
				body: { ok: true, traceId, plan: prior, children },
			};
		}
	}
	const run = (args: string[]): { out: string; err: string; code: number } => {
		const p = Bun.spawnSync([process.execPath, CLI("work.ts"), ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: p.stdout.toString(),
			err: p.stderr.toString(),
			code: p.exitCode,
		};
	};
	const add = run(["add", `plan: ${title}`, "--by", "board"]);
	if (add.code !== 0)
		return {
			status: 500,
			body: {
				ok: false,
				error: `plan registration failed: ${(add.err || add.out).slice(0, 300)}`,
			},
		};
	const m = add.out.split("\n")[0]?.match(/(W\d+(?:\.\d+)*) READY/);
	if (!m)
		return {
			status: 500,
			body: {
				ok: false,
				error: `plan registered but id unparsable: ${add.out.slice(0, 200)}`,
			},
		};
	const pid = m[1];
	const split = run([
		"split",
		pid,
		...kids,
		"--reason",
		"independent-scopes",
		"--plan",
		pid,
	]);
	if (split.code !== 0)
		return {
			status: 500,
			body: {
				ok: false,
				error: `split failed: ${(split.err || split.out).slice(0, 300)}`,
			},
		};
	// work add stored the key the CLI resolved from cwd (common git dir for a
	// repo) — read back by that same resolver, never the caller's raw string
	const key = projectIdentity(repo);
	const children = (
		db
			.query(
				"SELECT id, title FROM work_items WHERE project = ? AND parent_id = ? ORDER BY id",
			)
			.all(key, pid) as { id: string; title: string }[]
	).map((r) => ({ id: r.id, title: r.title }));
	if (traceId) {
		recordOrchStep(project, {
			traceId,
			at: Date.now(),
			phase: "work.registered",
			service: "work graph",
			status: "ok",
		});
		linkOrchWork(project, traceId, pid);
	}
	return { status: 200, body: { ok: true, traceId, plan: pid, children } };
}

// W125 — tokens_total for /metrics: the per-item token metrics (govdb
// tokenUsage) aggregated per project. tokenUsage parses lane transcripts
// (facts-cache keyed by mtime) — the aggregate refresh rides the /status TTL
// window, NEVER per scrape: a 293-transcript fleet must not be re-read on
// every poll. scrub keeps /Users paths out of the project labels.
