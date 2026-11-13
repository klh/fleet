// review-prompt.ts — W1476: the review lane's reviewer surface in one module:
// the prompt builder and the OpenAI-wire leg request review-lane.ts runs. The
// W792 review arena's lane arm loads this same module by config path
// (packages/belt/bench/arena/review-surface.json `lanePlugin` — the
// loadCondenser idiom, no cross-package import edge), so an arena rescore
// measures exactly what the lane sends: a prompt, model-pin or tooling change
// reruns the whole sealed set and the ledger records the score delta.
import { z } from "zod";
import { ReviewOutputError, terminalReviewVerdict } from "./review-output.ts";
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
// W2405: this is the FALLBACK, no longer the cap — the fleet_loop conf row
// review_leg_max_tokens (spawn env SUSPENDERS_REVIEW_LEG_MAX_TOKENS, 0 =
// omit the key entirely) overrides it; the owner directive removed the cap.
export const REVIEW_LEG_MAX_TOKENS = 16000;
export const REVIEW_LEG_TEMPERATURE = 0.2;

export interface ReviewLegReply {
	text: string;
	/** the SERVED wire model, when the upstream named one */
	model?: string;
	inTok: number;
	outTok: number;
}

const ReviewMessageSchema = z.object({
	content: z.string().nullable().optional(),
	reasoning_content: z.string().nullable().optional(),
	reasoning: z.string().nullable().optional(),
});
const ReviewResponseTextSchema = z.object({
	choices: z
		.array(z.object({ message: ReviewMessageSchema.optional() }))
		.optional(),
});
const ReviewLegResponseSchema = z.object({
	model: z.string().optional(),
	choices: z
		.array(
			z.object({
				finish_reason: z.string().nullable().optional(),
				message: ReviewMessageSchema.optional(),
			}),
		)
		.optional(),
	usage: z
		.object({
			prompt_tokens: z.number().optional(),
			completion_tokens: z.number().optional(),
		})
		.optional(),
});

/** One OpenAI-wire review call (the lane's buckle and llm legs). */
export async function requestReviewLeg(o: {
	url: string;
	model: string;
	key?: string;
	prompt: string;
	/** W2405: 0 = uncapped — no AbortSignal.timeout on the fetch. */
	timeoutMs: number;
	/** W2405: absent = REVIEW_LEG_MAX_TOKENS; 0 = OMIT the max_tokens key
	 *  (the provider default applies — the truncation culprit receipts
	 *  W2368/W2390/W2269.1.1 burned the budget before the VERDICT line). */
	maxTokens?: number;
	/** W1263: fires with the served wire model, before any empty-content throw */
	onWireModel?: (model: string) => void;
}): Promise<ReviewLegReply> {
	const maxTokens = o.maxTokens ?? REVIEW_LEG_MAX_TOKENS;
	const response = await fetch(o.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
		},
		body: JSON.stringify({
			model: o.model,
			messages: [{ role: "user", content: o.prompt }],
			...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
			temperature: REVIEW_LEG_TEMPERATURE,
		}),
		...(o.timeoutMs > 0 ? { signal: AbortSignal.timeout(o.timeoutMs) } : {}),
	});
	if (!response.ok) throw new Error(`Review LLM HTTP ${response.status}`);
	let json: unknown;
	try {
		json = await response.json();
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new ReviewOutputError("review HTTP-success response is not JSON");
		throw error;
	}
	const wire = ReviewLegResponseSchema.pick({ model: true }).safeParse(json);
	if (wire.success && wire.data.model) o.onWireModel?.(wire.data.model);
	const parsed = ReviewLegResponseSchema.safeParse(json);
	if (!parsed.success) {
		const partial = ReviewResponseTextSchema.safeParse(json);
		const message = partial.success
			? partial.data.choices?.[0]?.message
			: undefined;
		throw new ReviewOutputError(
			"review HTTP-success response has invalid review fields",
			message?.content ||
				message?.reasoning_content ||
				message?.reasoning ||
				undefined,
		);
	}
	const body = parsed.data;
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
	const usage = {
		inTok: body.usage?.prompt_tokens ?? 0,
		outTok: body.usage?.completion_tokens ?? 0,
	};
	const content = msg?.content ?? "";
	const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
	if (
		(content.trim() || reasoning.trim()) &&
		choice?.finish_reason !== undefined &&
		choice.finish_reason !== "stop"
	)
		throw new ReviewOutputError(
			"review HTTP-success output did not finish normally",
			content || reasoning,
		);
	if (content.trim()) return { text: content, model, ...usage };
	if (reasoning.trim()) {
		if (terminalReviewVerdict(reasoning))
			return { text: reasoning, model, ...usage };
		throw new ReviewOutputError(
			"review reasoning lacks a complete terminal verdict",
			reasoning,
		);
	}
	// W1263: BOTH fields empty = upstream empty (not parser loss). The throw
	// carries the SERVED wire model + full payload shape, so the ERROR receipt
	// self-describes the exact review-leg route for the operator.
	const emptyWire = typeof body.model === "string" ? body.model : "unknown";
	throw new ReviewOutputError(
		`review leg returned empty content (model=${emptyWire} finish_reason=${
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
