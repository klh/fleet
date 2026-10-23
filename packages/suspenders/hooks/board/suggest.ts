// hooks/board/suggest.ts — W163 composer suggest: the smallest fitting
// specialist expands a terse draft from the orchestrate box into a
// brief-shaped prompt. Context = the running lanes (sessions + claims +
// owned work items — the same plane `coord fleet` reads). W1119
// decision.single-buckle-inference: the call enters the shared Buckle
// client — the model preference rides as request metadata (the W136 hint
// grammar), never as a direct :8902/:890x endpoint; the gate is down → an
// honest 502, no solo reroute. Responses are cached draft-for-prompt so a
// re-click never re-bills the model.

import { db } from "./context.ts";
import { buckleChat } from "../lib/inference-buckle.ts";

export const SUGGEST = {
	DRAFT_MIN: 8,
	DRAFT_MAX: 2000,
	PROMPT_MIN: 40,
	PROMPT_MAX: 4000,
	CTX_LANES: 16,
	CACHE_MAX: 32,
	CACHE_TTL_MS: 10 * 60 * 1000,
	TIMEOUT_MS: 60_000,
	MAX_TOKENS: 700,
} as const;

// registry fit stays DATA: the extract specialist is the smallest fitting
// model, expressed as a hint (W136 grammar) — never as a direct endpoint.
export function suggestSpec(): string {
	return "prefer local extract";
}

const SUGGEST_MODEL = process.env.SUSPENDERS_SUGGEST_MODEL ?? "local-extract";

let sugModel: string | null = null;
export async function suggestModelResolve(): Promise<string> {
	if (sugModel === null) sugModel = SUGGEST_MODEL;
	return sugModel;
}

export const SUGGEST_SYS = `You expand terse project goals into brief-shaped prompts for a coding-agent fleet. Output ONLY the expanded prompt text — no preamble, no quotes, no markdown fences.
Shape: MISSION — what is being built and the done-when. PROTOCOL — worktree/branch, gates, commit discipline in a line or two. CONTEXT — constraints drawn from the draft and the running-lane list when relevant.
Rules: imperative voice; concrete; under 150 words; never invent ids, paths, names or requirements not present in the draft or the context; keep every hard requirement of the draft.`;

// running lanes, fleet-wide (the composer's project filter only colors the
// "this project" tag): sessions LEFT JOIN their claims and open owned work —
// deduped per sid, bounded, each line capped so the prompt stays small.
export function laneContext(project: string): string {
	const rows = db
		.query(
			`SELECT s.sid, s.project, c.intent, w.id AS wid, w.title AS wtitle
			 FROM sessions s
			 LEFT JOIN claims c ON c.sid = s.sid
			 LEFT JOIN work_items w ON w.owner_sid = s.sid
			   AND w.state NOT IN ('DONE','SUPERSEDED','SHATTERED')
			 WHERE s.state = 'RUNNING'
			 ORDER BY s.sid
			 LIMIT ?`,
		)
		.all(SUGGEST.CTX_LANES) as {
		sid: string;
		project: string | null;
		intent: string | null;
		wid: string | null;
		wtitle: string | null;
	}[];
	const seen = new Set<string>();
	const lanes: string[] = [];
	for (const r of rows) {
		if (seen.has(r.sid)) continue;
		seen.add(r.sid);
		const here = r.project === project ? " (this project)" : "";
		const doing = r.wid
			? `${r.wid} ${r.wtitle ?? ""}`
			: r.intent || "no claim — idle";
		lanes.push(`- ${r.sid}${here}: ${doing}`.slice(0, 200));
	}
	return `RUNNING LANES:\n${lanes.join("\n") || "(none)"}`;
}

// tolerate the 4B failure modes: <think> blocks, fence prose, runaway
// blank-line runs. Null when too little survives — the route answers 502.
export function parseSuggestion(text: string): string | null {
	const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const clean = noThink
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, SUGGEST.PROMPT_MAX);
	return clean.length >= SUGGEST.PROMPT_MIN ? clean : null;
}

// bounded LRU + TTL — a re-click on the same draft re-serves, never re-bills
const cache = new Map<string, { at: number; model: string; prompt: string }>();
function cacheGet(key: string): { model: string; prompt: string } | null {
	const e = cache.get(key);
	if (!e) return null;
	if (Date.now() - e.at > SUGGEST.CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}
	cache.delete(key);
	cache.set(key, e); // LRU refresh
	return { model: e.model, prompt: e.prompt };
}
function cacheSet(key: string, model: string, prompt: string): void {
	cache.delete(key);
	while (cache.size >= SUGGEST.CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	cache.set(key, { at: Date.now(), model, prompt });
}

// one llm.call telemetry event per suggest round-trip — the routing log
// shows failed calls too (orchestrate/advise pattern)
export function suggestTelemetry(payload: Record<string, unknown>): void {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'suggest', 'llm.call', NULL, ?, NULL)",
	).run(Date.now(), JSON.stringify(payload));
}

/** One gated suggest round-trip. The seam the caller-level test drives:
 *  `deps.env` substitutes the credential pair, `deps.fetcher` the wire —
 *  production resolves both from the process env / global fetch. */
export async function suggest(
	project: string,
	draft: string,
	deps: {
		env?: NodeJS.ProcessEnv;
		fetcher?: typeof fetch;
	} = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const key = `${project}\u0000${draft}`;
	const hit = cacheGet(key);
	if (hit)
		return {
			status: 200,
			body: {
				ok: true,
				prompt: hit.prompt,
				model: hit.model,
				ms: 0,
				cached: true,
			},
		};
	const ctx = laneContext(project);
	const t0 = Date.now();
	const model = await suggestModelResolve();
	let content = "";
	let llmError: string | null = null;
	let traceId: string | null = null;
	try {
		// W1119: the one gated leg — fail closed (throws) on a down gate or
		// missing scoped key; the honest 502 below is the caller's surface.
		const r = await buckleChat(
			{
				model,
				system: SUGGEST_SYS,
				user: `DRAFT:\n${draft}\n\n${ctx}`,
				maxTokens: SUGGEST.MAX_TOKENS,
				temperature: 0.3,
				hint: suggestSpec(),
				timeoutMs: SUGGEST.TIMEOUT_MS,
				...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
			},
			deps.env ?? process.env,
		);
		content = r.text;
		traceId = r.traceId;
	} catch (e) {
		llmError = e instanceof Error ? e.message : String(e);
	}
	suggestTelemetry({
		for: "suggest",
		model,
		host: "buckle",
		ms: Date.now() - t0,
		...(traceId ? { traceId } : {}),
		...(llmError ? { error: llmError.slice(0, 200) } : {}),
	});
	if (llmError)
		return { status: 502, body: { ok: false, error: llmError.slice(0, 300) } };
	const prompt = parseSuggestion(content);
	if (!prompt)
		return {
			status: 502,
			body: {
				ok: false,
				error:
					"model returned no usable suggestion — rephrase the draft and retry",
			},
		};
	cacheSet(key, model, prompt);
	return {
		status: 200,
		body: {
			ok: true,
			prompt,
			model,
			ms: Date.now() - t0,
		},
	};
}
