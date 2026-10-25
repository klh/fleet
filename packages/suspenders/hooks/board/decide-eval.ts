// hooks/board/decide-eval.ts — W217 decision re-evaluation. Each click on a
// decision card's re-evaluate button runs a FRESH evaluation through the
// local belt (:4000 shim — the proven anthropic→swarm path; W201: local/z.ai
// only), appends it to facts decision.eval.<event_id> (JSON array, capped),
// and returns the latest. No rate limit (owner: ad nauseum) — every click is
// stamped and kept so the owner can compare evaluations over time.

import { beltChat } from "../lib/hub/belt-chat.ts";
import { readBoardSettings } from "../lib/board/board-config.ts";
import {
	kevProbabilityLines,
	kevTypedDecision,
	parseOptions,
} from "../lib/knowledge/kev.ts";
import { CLI, db } from "./context.ts";

const CAP = 10;

// model discovery fallback (mirrors advise.ts defaultModel): an explicit
// SUSPENDERS_LLM_MODEL wins; otherwise ask the endpoint what it serves
let cachedModel: string | null = null;
async function evalModel(): Promise<string> {
	const want = readBoardSettings().settings.recommendation_model;
	if (want) return want;
	if (process.env.SUSPENDERS_LLM_MODEL) return process.env.SUSPENDERS_LLM_MODEL;
	if (cachedModel) return cachedModel;
	const base = llmBase();
	try {
		const r = await fetch(`${base}/models`, {
			signal: AbortSignal.timeout(5_000),
		});
		if (r.ok) {
			const d = (await r.json()) as { data?: { id?: string }[] };
			cachedModel = d.data?.[0]?.id ?? null;
		}
	} catch {
		// discovery failed — fall through to the generic id
	}
	return cachedModel ?? "default";
}

function llmBase(): string {
	const u =
		readBoardSettings().settings.recommendation_url ??
		process.env.SUSPENDERS_LLM_URL ??
		"http://127.0.0.1:8901/v1/chat/completions";
	return u.replace(/\/chat\/completions$/, "");
}

type EvalEntry = { ts: number; text: string };
type EvalRun = {
	runId: string;
	startedAt: number;
	running: boolean;
	error: string | null;
	workerPid?: number;
};
const RUN_LIMIT_MS = 135_000;
const runKey = (id: number): string => `decision.eval.${id}.run`;

function saveRun(id: number, run: EvalRun): void {
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'decision-eval', 1, ?)",
	).run(runKey(id), JSON.stringify(run), Date.now());
}

export function decisionEvalStatus(id: number): EvalRun | null {
	const row = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(runKey(id)) as { value: string } | null;
	if (!row) return null;
	try {
		const run = JSON.parse(row.value) as EvalRun;
		if (
			!run ||
			typeof run.startedAt !== "number" ||
			typeof run.runId !== "string"
		)
			return null;
		if (run.running && Date.now() - run.startedAt > RUN_LIMIT_MS)
			return {
				...run,
				running: false,
				error: "Evaluation worker timed out — retry",
			};
		return run;
	} catch {
		return null;
	}
}

export function finishDecisionEval(
	id: number,
	runId: string,
	error: string | null,
): void {
	const current = decisionEvalStatus(id);
	if (!current || current.runId !== runId) return;
	saveRun(id, { ...current, running: false, error });
}

function workerAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isSafeInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function launchWorker(id: number, run: EvalRun): void {
	try {
		const child = Bun.spawn(
			[process.execPath, CLI("decision-eval-worker.ts"), String(id), run.runId],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		const stderr = (async () => {
			let message = "";
			for await (const chunk of child.stderr)
				message = `${message}${new TextDecoder().decode(chunk)}`.slice(-500);
			return message.trim();
		})();
		void child.exited.then(async (code) => {
			const detail = await stderr;
			if (decisionEvalStatus(id)?.runId !== run.runId) return;
			if (decisionEvalStatus(id)?.running)
				finishDecisionEval(
					id,
					run.runId,
					`Evaluation worker exited ${code} without a result${detail ? `: ${detail.slice(0, 200)}` : ""}`,
				);
		});
		const current = decisionEvalStatus(id);
		if (current?.runId === run.runId && current.running)
			saveRun(id, { ...current, workerPid: child.pid });
		child.unref();
	} catch (error) {
		finishDecisionEval(
			id,
			run.runId,
			error instanceof Error ? error.message : String(error),
		);
	}
}

/** launchd may kill a board's child workers on restart; recover from facts. */
export function recoverDecisionEvals(): void {
	const rows = db
		.query("SELECT key FROM facts WHERE key LIKE 'decision.eval.%.run'")
		.all() as { key: string }[];
	for (const row of rows) {
		const id = Number(/^decision\.eval\.(\d+)\.run$/.exec(row.key)?.[1]);
		if (!Number.isSafeInteger(id) || id <= 0) continue;
		const run = decisionEvalStatus(id);
		if (run?.running && !workerAlive(run.workerPid)) launchWorker(id, run);
	}
}

/** A separate worker writes its run state to facts. */
export function startDecisionEval(id: number): {
	started: boolean;
	running: boolean;
	startedAt: number;
} {
	const current = decisionEvalStatus(id);
	if (current?.running)
		return { started: false, running: true, startedAt: current.startedAt };
	const run: EvalRun = {
		runId: crypto.randomUUID(),
		startedAt: Date.now(),
		running: true,
		error: null,
	};
	saveRun(id, run);
	launchWorker(id, run);
	return {
		started: true,
		running: decisionEvalStatus(id)?.running ?? false,
		startedAt: run.startedAt,
	};
}

const evalKey = (id: number): string => `decision.eval.${id}`;

export function decisionEvals(id: number): EvalEntry[] {
	const row = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(evalKey(id)) as { value: string | null } | null;
	try {
		const parsed = JSON.parse(row?.value ?? "[]") as EvalEntry[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Persist one evaluation (W552.6.1: one source of truth — the kev, gateway
 *  and direct paths all append through this). */
function persistEval(id: number, text: string): EvalEntry {
	const entry: EvalEntry = { ts: Date.now(), text };
	const all = [...decisionEvals(id), entry].slice(-CAP);
	db.query(
		"INSERT INTO facts (key, value, source, ts) VALUES (?, ?, 'decision-eval', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts",
	).run(evalKey(id), JSON.stringify(all), Date.now());
	return entry;
}

/** One fresh evaluation: the decision question + its linked work item. */
export async function evaluateDecision(id: number): Promise<EvalEntry> {
	const d = db
		.query(
			"SELECT question, options, task_id, project, state FROM decisions WHERE event_id = ?",
		)
		.get(id) as {
		question: string | null;
		options: string | null;
		task_id: string | null;
		project: string | null;
		state: string;
	} | null;
	if (!d) throw new Error(`unknown decision id: ${id}`);
	if (d.state !== "OPEN")
		throw new Error(`decision ${id} is ${d.state} — only OPEN evaluates`);

	// linked work-item context (task_id + project, the decisionRecords join)
	let itemCtx = "";
	if (d.task_id && d.project) {
		const it = db
			.query(
				"SELECT id, title, state, owner_sid FROM work_items WHERE project = ? AND id = ?",
			)
			.get(d.project, d.task_id) as {
			id: string;
			title: string;
			state: string;
			owner_sid: string | null;
		} | null;
		if (it)
			itemCtx = `\n- ${it.id} [${it.state}]${it.owner_sid ? ` owner ${it.owner_sid.slice(0, 8)}` : ""}: ${it.title}`;
	}

	const prompt = [
		"You are evaluating a pending decision for a human operator.",
		"Decision under evaluation:",
		String(d.question ?? "").slice(0, 4000),
		itemCtx ? `\nLinked work items:${itemCtx}` : "",
		"",
		"Produce a fresh, independent evaluation: (1) restate the options you see,",
		"(2) name risks/second-order effects, (3) give a one-line recommendation.",
		"Be specific to this decision, not generic. Max ~200 words.",
	].join("\n");

	const actor = readBoardSettings().settings.default_actor ?? "unassigned";

	// W225 kev-class typed pass first: a decision storing structured options
	// gets one systemone choice pass on the local model (~70 input tokens)
	// before the chat upstream is touched; null (kev down, <2 options,
	// malformed) leaves the chat path below unchanged.
	const kevOptions = parseOptions(d.options);
	if (kevOptions.length >= 2) {
		const kev = await kevTypedDecision({
			state: prompt,
			question: "Re-evaluate this pending decision: choose the best option.",
			options: kevOptions,
		});
		if (kev) {
			const pct = (n: number) => `${Math.round(n * 100)}%`;
			return persistEval(
				id,
				[
					`Recommendation: ${kev.choice} — ${kev.model} typed choice pass`,
					`Probabilities:\n${kevProbabilityLines(kev)
						.map((l) => `- ${l}`)
						.join("\n")}`,
					`Confidence ${pct(kev.confidence)} · ${kev.inputTokens} in / ${kev.outputTokens} out tokens · ${Math.round(kev.latencyMs / 100) / 10}s`,
				].join("\n"),
			);
		}
	}
	// W552.6.1: the governed gateway FIRST — belt picks the best healthy
	// target from its own metrics; the shared belt-chat leg validates the
	// reply, so a "(empty response)" placeholder is never stored as an
	// evaluation. Null (belt down, non-200, placeholder reply) degrades to
	// the direct SUSPENDERS_LLM_URL leg below, unchanged.
	const gw = await beltChat({
		role: "reasoning",
		user: prompt,
		maxTokens: 600,
		timeoutMs: 45_000,
	});
	if (gw) return persistEval(id, gw.text);
	// same executor contract as hooks/bin/advise.ts: SUSPENDERS_LLM_URL/KEY/
	// MODEL (openai-compat — the local swarm / z.ai path, W201 policy)
	const llmUrl = `${llmBase()}/chat/completions`;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (process.env.SUSPENDERS_LLM_KEY)
		headers.authorization = `Bearer ${process.env.SUSPENDERS_LLM_KEY}`;
	const res = await fetch(llmUrl, {
		method: "POST",
		headers: headers,
		signal: AbortSignal.timeout(60_000),
		body: JSON.stringify({
			model: await evalModel(),
			max_tokens: 600,
			messages: [{ role: "user", content: prompt }],
			user: actor,
		}),
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new Error(`eval upstream ${res.status}: ${t.slice(0, 200)}`);
	}
	const wire = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	const text = (wire.choices?.[0]?.message?.content ?? "").trim();
	if (!text) throw new Error("eval upstream returned no text");

	return persistEval(id, text);
}
