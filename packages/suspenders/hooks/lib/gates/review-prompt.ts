// review-prompt.ts — W1476: the review lane's reviewer surface in one module:
// the prompt builder and the OpenAI-wire leg request review-lane.ts runs. The
// W792 review arena's lane arm loads this same module by config path
// (packages/belt/bench/arena/review-surface.json `lanePlugin` — the
// loadCondenser idiom, no cross-package import edge), so an arena rescore
// measures exactly what the lane sends: a prompt, model-pin or tooling change
// reruns the whole sealed set and the ledger records the score delta.
import { reviewContext } from "./review-receipt.ts";

export interface ReviewPromptInput {
	item: string;
	repo: string;
	/** REVIEWED COMMIT */
	commit: string;
	/** INTEGRATION BASE */
	base: string;
	/** the instruction chain — reviewContext().text */
	context: string;
	title: string;
	/** empty = no description line suffix */
	description: string;
	state: string;
	owner: string;
	/** item thread lines, newest first */
	thread: string[];
	/** prior blocking-ID receipt lines for this exact commit */
	priorBlocking: string[];
	/** the exact branch diff; empty = claims-only review */
	diff: string;
}

/** The W182 second-opinion review prompt. */
export function reviewPrompt(p: ReviewPromptInput): string {
	return [
		`You are a read-only second-opinion reviewer for Work Graph item ${p.item} in ${p.repo}.`,
		`Verify the work against the mission; you are auditing, NOT re-doing it. Do not edit anything.`,
		`REVIEWED COMMIT ${p.commit}; INTEGRATION BASE ${p.base}`,
		p.context,
		``,
		// W1243.1.1 (FAIL62885): the old sentence implied the reviewer would see
		// proof output and the model refused PASS citing its absence. The ordering
		// is binding and must be unambiguous: the proof is harness-run AFTER the
		// provisional PASS; absent pre-verdict proof is not a finding.
		`PROOF ORDERING (Sinai rule, binding): the coverage proof is mechanical and runs in this harness, AFTER your verdict. You may emit a provisional PASS first; the harness then reverts the branch diff in a scratch checkout and requires the branch's new tests to fail there — tests that pass without the change downgrade the final verdict to FAIL.`,
		`No proof command or proof output appears in this prompt, by design. The absence of pre-verdict proof output is NOT a finding — do not open a blocker for missing coverage proof; fail-closed enforcement of the proof is the harness's job, not yours.`,
		`MISSION (work show):`,
		`${p.title}${p.description ? ` — ${p.description}` : ""}`,
		`state: ${p.state}; owner: ${p.owner}`,
		``,
		`ITEM THREAD (newest first, last 20):`,
		...(p.thread.length ? p.thread : ["(no events)"]),
		``,
		`PRIOR BLOCKING IDS FOR THIS EXACT COMMIT (receipt evidence, may include incomplete ERROR output):`,
		...(p.priorBlocking.length ? p.priorBlocking : ["(none)"]),
		``,
		`EXACT BRANCH DIFF (${p.base}...${p.commit}):`,
		p.diff || "(no branch — review the thread/claims only)",
		``,
		`Report findings as terse bullets; every finding carries a stable ID — B<round>-<slug> (blocker) or N<round>-<slug> (note) — round = the round that FIRST reported it; IDs are never renumbered.`,
		`ID discipline (W1263): B-prefix = merge-blocking defect, N-prefix = advisory. NEVER label advisory content with a B-prefix — every B-ID you emit blocks the merge until a reviewer explicitly resolves it, and advisory B-IDs accumulate a blocking union across review rounds that starves the merge ladder. When in doubt, use N.`,
		`Review silently: do not announce next steps or ask to continue — your whole reply is findings bullets plus the verdict line.`,
		`Explicitly resolved prior findings use a separate line RESOLVED: B<round>-<slug> followed by evidence. Unresolved blocker IDs prevent merge even with a PASS final line.`,
		`Prior blocking IDs (W1263): for every B-ID in PRIOR BLOCKING IDS, your reply must carry one line — either re-open it (state it as a finding bullet) or close it (RESOLVED: B<id> <one-line evidence>). A clean PASS with prior IDs silently absent is not a resolution and will be rejected by the receipt contract.`,
		`Evidence-kind caps severity: a file:line-only claim caps at blocker(high); a runtime-behavior claim without a trigger path caps at note(low).`,
		`End your reply with ONE machine-parseable final line:`,
		`VERDICT: PASS | VERDICT: FAIL - <reason>`,
	].join("\n");
}

// W1289: 8000 still cut Flash reviews off mid-reasoning before the required
// VERDICT line (W1286 receipt #70110). Leave room for the actual findings and
// terminal verdict after its reasoning pass.
export const REVIEW_LEG_MAX_TOKENS = 16000;
export const REVIEW_LEG_TEMPERATURE = 0.2;

export interface ReviewLegReply {
	text: string;
	/** the SERVED wire model, when the upstream named one */
	model?: string;
	inTok: number;
	outTok: number;
}

/** One OpenAI-wire review call (the lane's buckle and llm legs). */
export async function requestReviewLeg(o: {
	url: string;
	model: string;
	key?: string;
	prompt: string;
	timeoutMs: number;
	/** W1263: fires with the served wire model, before any empty-content throw */
	onWireModel?: (model: string) => void;
}): Promise<ReviewLegReply> {
	const response = await fetch(o.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
		},
		body: JSON.stringify({
			model: o.model,
			messages: [{ role: "user", content: o.prompt }],
			max_tokens: REVIEW_LEG_MAX_TOKENS,
			temperature: REVIEW_LEG_TEMPERATURE,
		}),
		signal: AbortSignal.timeout(o.timeoutMs),
	});
	if (!response.ok) throw new Error(`Review LLM HTTP ${response.status}`);
	const body = (await response.json()) as {
		model?: string;
		choices?: {
			finish_reason?: string;
			message?: {
				content?: string | null;
				reasoning_content?: string | null;
				reasoning?: string | null;
			};
		}[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	// W1236: an HTTP 200 with empty content is a leg FAILURE — finish_reason
	// "length" means the thinking budget ate the completion. Returning "" here
	// is the opaque "leg failed" receipt (verdict ERROR, no diagnostics).
	// W1263: reasoning legs (GLM family) fill reasoning_content and can stop
	// with content:"" while usage.completion_tokens>0 — the review text rides
	// the reasoning field. Recovering it is diagnosis, not fabrication: the
	// verdict parse and the Sinai coverage proof still gate the verdict.
	const choice = body.choices?.[0];
	const msg = choice?.message;
	const model =
		typeof body.model === "string" && body.model ? body.model : undefined;
	if (model) o.onWireModel?.(model);
	const usage = {
		inTok: body.usage?.prompt_tokens ?? 0,
		outTok: body.usage?.completion_tokens ?? 0,
	};
	const content = msg?.content ?? "";
	const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
	if (content.trim()) return { text: content, model, ...usage };
	if (reasoning.trim()) return { text: reasoning, model, ...usage };
	// W1263: BOTH fields empty = upstream empty (not parser loss). The throw
	// carries the SERVED wire model + full payload shape, so the ERROR receipt
	// self-describes the exact review-leg route for the operator.
	const wire = typeof body.model === "string" ? body.model : "unknown";
	throw new Error(
		`review leg returned empty content (model=${wire} finish_reason=${
			choice?.finish_reason ?? "unknown"
		}${
			body.usage?.completion_tokens === undefined
				? ""
				: `, completion_tokens=${body.usage.completion_tokens}`
		}, content_len=0, reasoning_len=0)`,
	);
}

/** The arena task fields the lane prompt reads (structurally the W792
 *  ReviewTask in packages/belt/bench/arena/review-core.ts). */
export interface ArenaReviewTask {
	id: string;
	title: string;
	mission: string;
	diff: string;
}

/** W1476 arena plugin face: the lane prompt for an arena task. It carries the
 *  root instruction chain at `root` HEAD (every lane review carries it; the
 *  per-directory files follow a real branch's paths), the task title and
 *  mission, no thread and no prior IDs, and the task's fixed→buggy diff. The
 *  chain is read once per prompter. */
export function arenaReviewPrompter(
	root: string,
): (task: ArenaReviewTask) => string {
	const chain = reviewContext(root, "HEAD");
	return (task) =>
		reviewPrompt({
			item: task.id,
			repo: "the W792 review arena",
			commit: `arena task ${task.id}`,
			base: chain.base,
			context: chain.text,
			title: task.title,
			description: task.mission,
			state: "DONE",
			owner: "none",
			thread: [],
			priorBlocking: [],
			diff: task.diff,
		});
}
