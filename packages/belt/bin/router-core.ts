// router-core.ts — router-shim policy + upstream I/O, importable for tests
// (router-shim.ts binds a port at module load). W270 bench-informed fixes:
//   - code detection: strong vs weak signals; weak tokens (api/return/debug)
//     no longer turn a long log haystack into a "code" task
//   - Anthropic `system` is forwarded and (when short) classified
//   - Kev pre-hop gated by Kev's context window (no serial hop on long prompts)
//   - budget policy: per-model thinking/min-budget table (data, not branches)
//   - upstream 429 + Retry-After honored (bounded wait, then fallback/propagate)
//   - OpenAI SSE → Anthropic SSE streaming translation (TTFT = first token)

import { envInt } from "./admission.ts";
import { EXTERNAL, type Specialist } from "./registry.ts";
import { anthropicMessagesToOpenAi } from "./router-tools.ts";
import { childTraceparent } from "../../telemetry/src/http-trace.ts";
import {
	emptyStreamError,
	StreamSemantics,
} from "../../buckle/src/stream-semantics.ts";
import { upstreamErrorDetail } from "../../buckle/src/error-detail.ts";

// ─── 7-dimension complexity scoring (LiteLLM Auto Router pattern) ───
export interface ComplexityScore {
	total: number; // 0..1 (higher = more complex)
	tier: "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";
	dimensions: Record<string, number>;
}

// Lower thresholds (were too conservative — 0.221 scored as SIMPLE)
export const TIER_THRESHOLDS = { SIMPLE: 0.15, MEDIUM: 0.35, COMPLEX: 0.6 };

// Strong code signals: any one hit makes the request a code task.
export const CODE_STRONG: Array<{ name: string; re: RegExp }> = [
	{ name: "fence", re: /```/ },
	{
		name: "language",
		re: /\b(javascript|typescript|python|golang|rust|java|kotlin|swift|ruby|php|csharp|c\+\+|c#|haskell|scala|elixir|lua|perl|bash\s+script|shell\s+script|powershell|sql\s+query|regex)\b/i,
	},
	{
		name: "write-code",
		re: /\b(write|implement|create|code|fix|refactor|debug|complete)\s+(an?\s+|the\s+|this\s+|my\s+)?(\w+\s+){0,2}(function|method|class|script|program|snippet|module|tests?|regex|query|algorithm|component|endpoint)\b/i,
	},
	{
		// W279: fixing code — defect nouns the write-code verb list misses
		name: "defect-fix",
		re: /\b(remove|patch|fix|add|address)\b[^.?!]{0,40}\b(memory\s+leak|race\s+condition|deadlock|type\s+annotations?|regression|failing\s+tests?)\b/i,
	},
	{
		name: "signature",
		re: /\b[a-z_$][\w$]*\((?!s\))\s*[a-z_$][\w$]*(\s*,\s*[a-z_$][\w$]*)*\s*\)\s*(:|=>|\{|that|which|returns?|to\s+return|should)/i,
	},
	{
		name: "decl",
		re: /^\s*(def|function|class|import|export|const|let|var|public|private|fn|func|#include)\s+\S/m,
	},
	{
		// a signature leading a line, any args — "rle(s) should return …"
		name: "signature-lead",
		re: /^\s*[a-z_$][\w$]*\(\s*[a-z_$][\w$]*(\s*,\s*[a-z_$][\w$]*)*\s*\)\s*(:|=>|\{|that|which|returns?|to\s+return|should)/im,
	},
	{ name: "arrow", re: /\)\s*=>/ },
];

// Weak code signals: generic engineering vocabulary that also fills logs,
// tickets, and prose. They count only in short prompts and only in numbers.
export const CODE_WEAK =
	/\b(function|class|interface|async|await|return|refactor|debug|compile|lint|api|endpoint|component|hook|docker|kubernetes|algorithm|implement|optimize|typescript|javascript|python|middleware|module|handler|cron)\b/gi;
export const CODE_WEAK_MIN = 2; // distinct weak hits needed
export const LONG_PROMPT_WORDS = 1500; // above this, weak hits never count

export function codeSignal(text: string): {
	isCode: boolean;
	strong: string[];
	weak: string[];
} {
	const strong = CODE_STRONG.filter((s) => s.re.test(text)).map((s) => s.name);
	const words = text.split(/\s+/).length;
	const weak =
		words > LONG_PROMPT_WORDS
			? []
			: [...new Set((text.match(CODE_WEAK) ?? []).map((w) => w.toLowerCase()))];
	return {
		isCode: strong.length > 0 || weak.length >= CODE_WEAK_MIN,
		strong,
		weak,
	};
}

const REASONING_MARKERS =
	/\b(analyze|explain|compare|evaluate|design|architect|strategy|why|how\s+does|what\s+if|pros\s+and\s+cons|trade.?off|implications|consequences|root\s+cause|derive|prove|justify|critique)\b/gi;
const TECHNICAL_TERMS =
	/\b(distributed|concurrency|latency|throughput|scalab|migration|protocol|authentication|encryption|database|schema|middleware|microservice|monolith|event.?driven|state\s+machine|compiler|runtime|garbage\s+collection)\b/gi;
const SIMPLE_INDICATORS =
	/^(reply|respond|list|name|give\s+me|tell\s+me|what\s+is|who\s+is|when\s+is|where\s+is|how\s+many|convert|translate|summarize\s+this|format\s+this|sort\s+this)\b/i;
const MULTI_STEP =
	/\b(first.*then|step\s+\d|also\s+after|additionally|furthermore|meanwhile|subsequently|before\s+that|after\s+that|next\s+you|finally)\b/i;
const QUESTION_DEPTH =
	/\b(underlying|fundamental|philosophical|theoretical|abstract|conceptual|architectural|systemic|holistic|nuanced|paradox|dilemma|emergence)\b/i;

const WEIGHTS: Record<string, number> = {
	tokenCount: 0.15,
	codePresence: 0.25,
	reasoningMarkers: 0.25,
	technicalTerms: 0.1,
	simpleIndicators: 0.1,
	multiStep: 0.05,
	questionComplexity: 0.1,
};

export function scoreComplexity(text: string): ComplexityScore {
	const lower = text.toLowerCase();
	const words = text.split(/\s+/).length;
	const dimensions: Record<string, number> = {
		tokenCount: Math.min(words / 200, 1),
		codePresence: codeSignal(text).isCode ? 0.8 : 0,
		reasoningMarkers: (lower.match(REASONING_MARKERS) ?? []).length * 0.25,
		technicalTerms: (lower.match(TECHNICAL_TERMS) ?? []).length * 0.2,
		simpleIndicators: SIMPLE_INDICATORS.test(text.trim()) ? -0.3 : 0, // NEGATIVE weight
		multiStep: MULTI_STEP.test(lower) ? 0.3 : 0,
		questionComplexity: QUESTION_DEPTH.test(lower) ? 0.4 : 0,
	};
	let total = 0;
	for (const [dim, weight] of Object.entries(WEIGHTS)) {
		dimensions[dim] = Math.max(0, Math.min(1, dimensions[dim] ?? 0));
		total += dimensions[dim] * weight;
	}
	total = Math.max(0, Math.min(1, total));

	// code tasks always route to coder regardless of complexity
	if (dimensions.codePresence > 0.5)
		return { total, tier: "MEDIUM", dimensions };

	let tier: ComplexityScore["tier"];
	if (total < TIER_THRESHOLDS.SIMPLE) tier = "SIMPLE";
	else if (total < TIER_THRESHOLDS.MEDIUM) tier = "MEDIUM";
	else if (total < TIER_THRESHOLDS.COMPLEX) tier = "COMPLEX";
	else tier = "VERY_COMPLEX";
	return { total, tier, dimensions };
}

// ─── W279: serving-tier (e-label) mapping ───
// scoreComplexity chooses a PLACEMENT (SIMPLE→extract, MEDIUM→coder,
// COMPLEX→reason) but cannot express the serving-tier vocabulary the bench
// decision class seals as TIERS (bench/arena/core.ts): coder/extract/reason/
// general/cloud/none. These detectors implement that criteria text
// deterministically — same spirit as the Danish word-list rule — and the
// label rides _routing.category so the arena's routedTier() scores the
// DECISION, not the best-effort placement after fallback. Order = the
// criteria are disjoint by construction: none → cloud → code → danish →
// general → reason → complexity fallback.
export type ELabel =
	| "coder"
	| "extract"
	| "reason"
	| "general"
	| "cloud"
	| "none";
export interface ELabelDecision {
	label: ELabel;
	why: string;
}

// TIERS.none — needs a capability no text model has.
const NONE_RES: RegExp[] = [
	/\b(generate|create|produce|make|draw|render|paint)\b[^.?!]{0,80}\b(image|photo|picture|illustration|drawing|rendering)\b/i,
	/\b(generate|create|produce|make|record|edit|trim)\b[^.?!]{0,80}\b(video|clip)\b/i,
	/\btranscrib\w*\b[^.?!]{0,80}\b(audio|recording)\b/i,
	/\bbrowse the (live )?web\b/i,
	/\b(phone|call|ring)\b[^.?!]{0,40}\band (ask|book|order)\b/i,
];
// TIERS.cloud — input stated >32k tokens, or explicit frontier-model demand.
export const CLOUD_TOKEN_THRESHOLD = 32_000;
const CLOUD_SIZE_RE = /\b(\d[\d,.]*)\s*(k)?\s*-?\s*tokens?\b/i;
const CLOUD_DEMAND_RE = /\bfrontier (cloud )?model\b|\bnothing local\b/i;

/** Danish/multilingual detection — deterministic word list + æøå (moved from
 *  router-shim with W279; classifyELabel owns it). Two strong hits, or one
 *  strong + weak, or three weak; æøå shares with Norwegian, but :8906 covers
 *  201 langs either way. */
const DA_STRONG =
	/\b(jeg|ikke|hvad|hvordan|hvorfor|hvilken|hvilket|hvilke|også|måske|dansk|danmark|hygge|mig|dig)\b/gi;
const DA_WEAK =
	/\b(og|er|det|som|på|til|af|med|der|hun|han|vi|har|skal|år)\b/gi;
export function isDanish(text: string): boolean {
	const strong = (text.match(DA_STRONG) ?? []).length;
	const weak = (text.match(DA_WEAK) ?? []).length;
	if ((text.match(/[æøå]/gi) ?? []).length >= 2) return true;
	return strong >= 2 || (strong >= 1 && weak >= 1) || weak >= 3;
}

// TIERS.general — writing in a language other than English; translation.
const LANGS =
	"danish|french|german|spanish|swedish|norwegian|icelandic|dutch|italian|polish|portuguese|finnish|czech|greek|turkish|japanese|chinese|korean|arabic|hindi|russian|ukrainian|hungarian|romanian|bulgarian|serbian|croatian|hebrew|thai|vietnamese|indonesian";
const GENERAL_LANG_RE = new RegExp(`\\b(?:in|to|into)\\s+(${LANGS})\\b`, "i");
const TRANSLATE_RE = /\btranslat\w*\b/i;

// TIERS.reason — multi-step analysis/planning/maths/trade-offs, without code.
const REASON_RES: RegExp[] = [
	/\bwithout (?:writing any |any )?code\b/i,
	/\b(analyz\w*|analys\w*|estimat\w*|trade.?offs?|risks of|work out|step by step|cheaper)\b/i,
];

/** The special serving tiers the complexity score cannot express; null = fall
 *  through to the complexity fallback in classifyELabel. First hit wins. */
export function eLabelSpecial(text: string): ELabelDecision | null {
	if (NONE_RES.some((re) => re.test(text)))
		return { label: "none", why: "non-text capability" };
	const size = CLOUD_SIZE_RE.exec(text);
	if (
		(size &&
			Number(size[1].replace(/,/g, "")) * (size[2] ? 1000 : 1) >
				CLOUD_TOKEN_THRESHOLD) ||
		CLOUD_DEMAND_RE.test(text)
	)
		return {
			label: "cloud",
			why: "stated >32k input or explicit frontier demand",
		};
	if (codeSignal(text).isCode) return { label: "coder", why: "code signal" };
	if (GENERAL_LANG_RE.test(text) || TRANSLATE_RE.test(text))
		return { label: "general", why: "non-English output or translation" };
	if (REASON_RES.some((re) => re.test(text)))
		return { label: "reason", why: "prose analysis, no code" };
	return null;
}

/** Total serving-tier decision: special detectors in priority order (none →
 *  cloud → code → general-language/translation → reason), then the Danish
 *  word-list rule (language beats task class), then the complexity fallback —
 *  the pre-W279 shim placement (SIMPLE→extract, else reason) preserved. */
export function classifyELabel(
	text: string,
	score: ComplexityScore,
): ELabelDecision {
	const special = eLabelSpecial(text);
	if (special) return special;
	if (isDanish(text)) return { label: "general", why: "danish word list" };
	if (score.tier === "SIMPLE")
		return { label: "extract", why: "complexity SIMPLE" };
	return { label: "reason", why: `complexity ${score.tier}` };
}

// ─── Anthropic request shape → classifier text + OpenAI messages ───
export interface AnthropicBody {
	model?: string;
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
	system?: unknown;
	messages?: Array<{ role: unknown; content: unknown }>;
	/** W789: passthrough request fields for the tools bridge. */
	tools?: unknown;
	tool_choice?: unknown;
	_force_dead_port?: number;
}

export const blockText = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.map((b) => {
						const t = (b as { text?: unknown } | null)?.text;
						return typeof t === "string" ? t : "";
					})
					.join("")
			: "";

// A short system prompt is a task instruction ("reply with one JS function");
// a long one is an agent harness (Claude Code) whose vocabulary would make
// every request look like code — only the former is classified.
export const SYSTEM_CLASSIFY_MAX_CHARS = 2000;

export function classifierText(body: AnthropicBody): string {
	const sys = blockText(body.system);
	const msgs = (body.messages ?? []).map((m) => blockText(m.content));
	if (sys && sys.length <= SYSTEM_CLASSIFY_MAX_CHARS) msgs.unshift(sys);
	return msgs.join(" ");
}

export type ChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** OpenAI function-calling protocol (W761.1): assistant tool_calls and
	 *  tool-role results ride history so multi-turn tool loops survive the
	 *  Anthropic→OpenAI translation. */
	tool_calls?: OpenAiToolCall[];
	tool_call_id?: string;
};

/** OpenAI messages with the Anthropic `system` forwarded (it was dropped
 *  before W270) and Qwen3's `/no_think` appended to it. */
export function toOpenAiMessages(body: AnthropicBody): ChatMessage[] {
	const sys = blockText(body.system).trim();
	const messages: ChatMessage[] = anthropicMessagesToOpenAi(body);
	messages.unshift({
		role: "system",
		content: sys ? `${sys} /no_think` : "/no_think",
	});
	return messages;
}

// ─── tool calling (W761.1): anthropic tools ⇄ OpenAI function calling ───
export interface OpenAiToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OpenAiToolDef {
	type: "function";
	function: { name: string; description?: string; parameters: unknown };
}

/** Anthropic tools[] → OpenAI tools[]; nameless entries are skipped. */
export function toOpenAiTools(tools: unknown): OpenAiToolDef[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const out: OpenAiToolDef[] = [];
	for (const t of tools as Array<{
		name?: unknown;
		description?: unknown;
		input_schema?: unknown;
	}>) {
		if (typeof t?.name !== "string") continue;
		out.push({
			type: "function",
			function: {
				name: t.name,
				parameters: t.input_schema ?? { type: "object", properties: {} },
			},
		});
	}
	return out.length > 0 ? out : undefined;
}

/** Anthropic tool_choice → OpenAI tool_choice (auto | required | named). */
export function toolChoiceToOpenAi(tc: unknown): unknown {
	if (typeof tc !== "object" || tc === null) return undefined;
	const j = tc as { type?: unknown; name?: unknown };
	if (j.type === "tool" && typeof j.name === "string")
		return { type: "function", function: { name: j.name } };
	if (j.type === "auto") return "auto";
	if (j.type === "any") return "required";
	return undefined;
}

/** Tool calls on an OpenAI chat message, name-bearing entries only. */
export const toolCallsOf = (msg: unknown): OpenAiToolCall[] => {
	const j = msg as { tool_calls?: unknown } | undefined;
	if (!Array.isArray(j?.tool_calls)) return [];
	return (j.tool_calls as OpenAiToolCall[]).filter(
		(c) => typeof c?.function?.name === "string",
	);
};

// ─── Kev pre-hop eligibility ───
const KEV_CONTEXT_TOKENS =
	EXTERNAL.find((e) => e.role === "classify")?.contextTokens ?? 384;
export const estTokens = (text: string): number => Math.ceil(text.length / 4);

/** Kev was trained on ≤ contextTokens of state; past that its verdict is
 *  unmeasured and the serial hop only adds latency ahead of the prefill
 *  (stack-anthropic f-class TTFT 8.8 s vs 2.5-3.5 s elsewhere). */
export const kevEligible = (text: string, ctx = KEV_CONTEXT_TOKENS): boolean =>
	estTokens(text) <= ctx;

/**
 * W786: kev escalate-gate verdict — a cloud-labeled request stays on the best
 * local tier when kev's typed escalate question answers local_adequate.
 * Fail-open by construction: any other label, missing answer, or kev outage
 * keeps today's cloud-first behavior untouched.
 */
export const kevEscalateVeto = (
	label: string,
	choice: string | undefined,
): boolean => label === "cloud" && choice === "local_adequate";

// ─── budget policy: per-model thinking control (data, not branches) ───
export interface BudgetRule {
	match: RegExp;
	/** "off": thinking can be disabled via `offExtra` (router always does — speed);
	 *  "always": the model thinks at every effort, so max_tokens is shared. */
	thinking: "off" | "always";
	minBudget: number;
	offExtra?: Record<string, unknown>;
}

export const BUDGET_RULES: BudgetRule[] = [
	// Qwen3.5 thinking is template-controlled — /no_think in the prompt doesn't
	// reach it; the kwarg does (verified direct-answer with this off, Sep 23).
	{
		match: /Qwen3\.5-/,
		thinking: "off",
		minBudget: 0,
		offExtra: { chat_template_kwargs: { enable_thinking: false } },
	},
	// GLM-5.3(-flash) always thinks (thinking disabled → 400). Bench a-class:
	// max_tokens 1024 at effort low truncated 100% (pure-api) — reasoning ate
	// the shared budget. Below minBudget the router raises it.
	{
		match: /^(z\.ai:)?glm-5\.3(-flash)?(\[1m\])?$/,
		thinking: "always",
		minBudget: 2048,
	},
];

export function applyBudget(
	model: string,
	maxTokens: number,
	rules: BudgetRule[] = BUDGET_RULES,
): { maxTokens: number; extra: Record<string, unknown>; note?: string } {
	const rule = rules.find((r) => r.match.test(model));
	if (!rule) return { maxTokens, extra: {} };
	if (rule.thinking === "off") return { maxTokens, extra: rule.offExtra ?? {} };
	// Probe-scale budgets (< 64: health pings, liveness checks) are explicit —
	// raising them to minBudget turns a 1-token pong into a 2048-token thinking
	// request (2026-10-03: bench preflight timed out on exactly this).
	if (maxTokens < 64) return { maxTokens, extra: {} };
	if (maxTokens >= rule.minBudget) return { maxTokens, extra: {} };
	return {
		maxTokens: rule.minBudget,
		extra: {},
		note: `budget ${maxTokens}→${rule.minBudget} (${model} always thinks)`,
	};
}

// ─── Retry-After ───
// envInt lives in admission.ts (W669.12 dedup); min=0 keeps the
// wait-cap-expresses-no-cap semantics (BELT_RETRY_WAIT_CAP_MS=0).
/** Longest upstream Retry-After the router waits out in-request before
 *  taking the fallback hop instead. */
export const RETRY_WAIT_CAP_MS = envInt(
	process.env.BELT_RETRY_WAIT_CAP_MS,
	2000,
	0,
);

/** Retry-After (delta-seconds or HTTP-date) → ms; undefined when absent/bad. */
export function retryAfterMs(
	h: string | null,
	now = Date.now(),
): number | undefined {
	if (h === null || h.trim() === "") return undefined;
	const s = Number(h);
	if (Number.isFinite(s)) return s >= 0 ? Math.round(s * 1000) : undefined;
	const at = Date.parse(h);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// ─── per-request timings (W257) ───
/** Router-side wall clock, t0 = request receipt. prefill_ms = t0 → upstream
 *  open (queue + prompt prefill); ttft_ms = t0 → first content token;
 *  decode_ms = first token → end. ttft/decode only exist on streamed legs —
 *  a buffered completion hides decode inside prefill, so a field the leg
 *  can't observe stays absent, never zero. */
export interface RequestTimings {
	total_ms: number;
	prefill_ms?: number;
	ttft_ms?: number;
	decode_ms?: number;
}

/** t0 → upstream-open window shared by viaLocal + openLocalStream. */
const openWindow = (
	t0: number | undefined,
	openAt: number | undefined,
	endAt: number,
): Pick<RequestTimings, "total_ms" | "prefill_ms"> => ({
	total_ms: Math.round(endAt - (t0 ?? endAt)),
	prefill_ms:
		t0 === undefined
			? Math.round(endAt - endAt)
			: openAt === undefined
				? Math.round(endAt - t0)
				: Math.round(openAt - t0),
});

// ─── specialist call (OpenAI format) ───
export interface LocalResult {
	ok: boolean;
	response: string;
	error?: string;
	status?: number;
	retryAfterMs?: number;
	finish?: string;
}

export interface LocalResult {
	ok: boolean;
	response: string;
	error?: string;
	status?: number;
	retryAfterMs?: number;
	finish?: string;
	/** W761.1: OpenAI-wire tool calls translated back to tool_use blocks. */
	toolCalls?: OpenAiToolCall[];
	timings?: RequestTimings;
}

export interface CallOpts {
	base?: string; // default http://localhost:<port>
	extra?: Record<string, unknown>;
	/** W789: converted OpenAI tool defs + tool_choice forwarded upstream. */
	tools?: OpenAiToolDef[];
	toolChoice?: unknown;
	timeoutMs?: number;
	/** W257: performance.now() at request receipt — enables per-attempt
	 *  timings on the used hop. */
	startedAt?: number;
	/** Parent trace from the Belt ingress. Each specialist attempt gets a child span. */
	traceparent?: string;
	requestId?: string;
	preference?: string | null;
	onAttempt?: (receipt: {
		hop: "local-specialist";
		traceparent: string | null;
		requestId: string | null;
		port: number;
		status?: number;
		durationMs: number;
		retryAfterMs?: number;
		failureKind?: "http" | "transport" | "decode" | "empty";
	}) => void;
}

export const specialistBase = (port: number): string =>
	process.env.BELT_UPSTREAM_BASE ?? `http://localhost:${port}`;

const strip = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export async function viaLocal(
	r: { port: number; model: string },
	messages: ChatMessage[],
	maxTokens: number,
	temperature: number,
	opts: CallOpts = {},
): Promise<LocalResult> {
	let text = "";
	const t0 = opts.startedAt;
	const attemptStarted = performance.now();
	const attemptTrace = opts.traceparent
		? childTraceparent(opts.traceparent)
		: null;
	let status: number | undefined;
	let retryAfter: number | undefined;
	let failureKind: "http" | "transport" | "decode" | "empty" | undefined;
	try {
		const res = await fetch(
			`${opts.base ?? specialistBase(r.port)}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(attemptTrace ? { traceparent: attemptTrace } : {}),
					...(opts.requestId ? { "x-klh-request-id": opts.requestId } : {}),
					...(opts.preference ? { "x-klh-prefer": opts.preference } : {}),
				},
				signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
				body: JSON.stringify({
					model: r.model,
					messages,
					max_tokens: maxTokens,
					temperature,
					stream: false,
					...(opts.tools ? { tools: opts.tools } : {}),
					...(opts.toolChoice !== undefined
						? { tool_choice: opts.toolChoice }
						: {}),
					...(opts.extra ?? {}),
				}),
			},
		);
		status = res.status;
		if (!res.ok) failureKind = "http";
		const tOpen = t0 === undefined ? undefined : performance.now();
		if (res.status === 429) {
			failureKind = "http";
			retryAfter = retryAfterMs(res.headers.get("retry-after"));
			await res.body?.cancel();
			return {
				ok: false,
				response: "",
				status: 429,
				retryAfterMs: retryAfter,
				error: "429 overloaded",
			};
		}
		text = await res.text();
		// mlx_lm occasionally emits raw newlines inside JSON strings — strict
		// parse first (preserves unicode), fall back to escaping control chars.
		let j: {
			error?: string | { message?: string };
			choices?: Array<{
				finish_reason?: string;
				message?: { content?: string; reasoning_content?: string };
			}>;
		};
		try {
			j = JSON.parse(text);
		} catch {
			j = JSON.parse(text.replace(/\n/g, "\\n"));
		}
		if (j.error) {
			failureKind = "http";
			return {
				ok: false,
				response: "",
				status: res.status,
				error:
					typeof j.error === "string"
						? j.error
						: (j.error.message ?? "specialist error"),
			};
		}
		const choice = j.choices?.[0];
		const msg = choice?.message ?? {};
		const toolCalls = toolCallsOf(msg);
		const response =
			strip(msg.content || "") || strip(msg.reasoning_content || "");
		if (!response && toolCalls.length === 0) {
			failureKind = "empty";
			return {
				ok: false,
				response: "",
				status: res.status,
				error: `empty (finish=${choice?.finish_reason ?? "?"}, keys=${Object.keys(msg).join("+") || "none"})`,
			};
		}
		return {
			ok: true,
			response,
			status: res.status,
			finish: choice?.finish_reason,
			...(toolCalls.length > 0 ? { toolCalls } : {}),
			...(t0 !== undefined
				? { timings: openWindow(t0, tOpen, performance.now()) }
				: {}),
		};
	} catch (e) {
		failureKind = status === undefined ? "transport" : "decode";
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			response: "",
			error: `${msg}${text ? ` | raw: ${text.slice(0, 120)}` : ""}`,
		};
	} finally {
		opts.onAttempt?.({
			hop: "local-specialist",
			traceparent: attemptTrace,
			requestId: opts.requestId ?? null,
			port: r.port,
			status,
			durationMs: Math.round(performance.now() - attemptStarted),
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
			...(failureKind ? { failureKind } : {}),
		});
	}
}

/** One call; on 429 with Retry-After ≤ cap, wait it out and retry once on
 *  the same specialist (prefix cache stays warm there). Longer waits return
 *  the 429 so the caller takes the fallback hop or propagates it. */
export async function callHonoringRetryAfter<
	T extends { status?: number; retryAfterMs?: number },
>(
	call: () => Promise<T>,
	capMs = RETRY_WAIT_CAP_MS,
	sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<T> {
	const first = await call();
	if (first.status !== 429) return first;
	const wait = first.retryAfterMs ?? capMs;
	if (wait > capMs) return first;
	await sleep(wait);
	return call();
}

// ─── streaming: specialist SSE → Anthropic SSE ───
export type StreamOpen =
	| {
			ok: true;
			body: ReadableStream<Uint8Array>;
			/** W257: performance.now() when the upstream opened (headers in). */
			openedAt?: number;
	  }
	| { ok: false; error: string; status?: number; retryAfterMs?: number };

export async function openLocalStream(
	r: { port: number; model: string },
	messages: ChatMessage[],
	maxTokens: number,
	temperature: number,
	opts: CallOpts = {},
): Promise<StreamOpen> {
	const attemptStarted = performance.now();
	const attemptTrace = opts.traceparent
		? childTraceparent(opts.traceparent)
		: null;
	let status: number | undefined;
	let retryAfter: number | undefined;
	let failureKind: "http" | "transport" | "decode" | "empty" | undefined;
	// W739 (opus-review f2f5602a): the TTFB timer was only disarmed on the
	// open-success path — a failed open (ECONNREFUSED) left it armed for the
	// full window. Self-expiring, but ref'd; clear on every exit path.
	let ttfb: ReturnType<typeof setTimeout> | undefined;
	try {
		// W278: connect/TTFB-only timeout — AbortSignal.timeout stayed armed
		// through the body and cut healthy streams >120s mid-generation. Once
		// headers land the pump + client cancel() own the body; a stale one-shot
		// fire after a failed open only aborts an orphaned controller (no-op).
		const ctrl = new AbortController();
		ttfb = setTimeout(
			() => ctrl.abort(new Error("ttfb timeout")),
			opts.timeoutMs ?? 120_000,
		);
		const res = await fetch(
			`${opts.base ?? specialistBase(r.port)}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream",
					...(attemptTrace ? { traceparent: attemptTrace } : {}),
					...(opts.requestId ? { "x-klh-request-id": opts.requestId } : {}),
					...(opts.preference ? { "x-klh-prefer": opts.preference } : {}),
				},
				signal: ctrl.signal,
				body: JSON.stringify({
					model: r.model,
					messages,
					max_tokens: maxTokens,
					temperature,
					stream: true,
					...(opts.tools ? { tools: opts.tools } : {}),
					...(opts.toolChoice !== undefined
						? { tool_choice: opts.toolChoice }
						: {}),
					...(opts.extra ?? {}),
				}),
			},
		);
		status = res.status;
		// headers in — disarm; a late fire would abort the live body (the
		// signal stays bound to the fetch). On a failed open the stale fire
		// aborts an orphaned controller: harmless no-op.
		clearTimeout(ttfb);
		const ct = res.headers.get("content-type") ?? "";
		if (res.ok && res.body && ct.includes("text/event-stream"))
			return {
				ok: true,
				body: res.body,
				...(opts.startedAt !== undefined
					? { openedAt: performance.now() }
					: {}),
			};
		failureKind = res.ok ? "decode" : "http";
		// W732: post-header non-SSE bodies have no pump/client-cancel owner —
		// a header-then-stall upstream hung this drain (and the request)
		// forever. Cap it at the same open window; the abort frees the
		// still-bound body.
		const raw = await new Promise<string>((resolve) => {
			const t = setTimeout(() => {
				ctrl.abort(new Error("error-body stall"));
				resolve("");
			}, opts.timeoutMs ?? 120_000);
			res
				.text()
				.catch(() => "")
				.then((s) => {
					clearTimeout(t);
					resolve(s);
				});
		});
		retryAfter =
			res.status === 429
				? retryAfterMs(res.headers.get("retry-after"))
				: undefined;
		return {
			ok: false,
			status: res.status,
			retryAfterMs: retryAfter,
			error: `${res.status} ${ct || "no content-type"}${raw ? ` | raw: ${raw.slice(0, 120)}` : ""}`,
		};
	} catch (e) {
		failureKind = status === undefined ? "transport" : "decode";
		if (ttfb) clearTimeout(ttfb);
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	} finally {
		opts.onAttempt?.({
			hop: "local-specialist",
			traceparent: attemptTrace,
			requestId: opts.requestId ?? null,
			port: r.port,
			status,
			durationMs: Math.round(performance.now() - attemptStarted),
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
			...(failureKind ? { failureKind } : {}),
		});
	}
}

/** Drops <think>…</think> spans across chunk boundaries. */
export function thinkFilter(): (chunk: string) => string {
	let inThink = false;
	let carry = "";
	return (chunk) => {
		let s = carry + chunk;
		carry = "";
		let out = "";
		for (;;) {
			const tag = inThink ? "</think>" : "<think>";
			const i = s.indexOf(tag);
			if (i >= 0) {
				if (!inThink) out += s.slice(0, i);
				s = s.slice(i + tag.length);
				inThink = !inThink;
				continue;
			}
			// hold back a possible partial tag at the end
			let keep = 0;
			for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
				if (tag.startsWith(s.slice(s.length - k))) {
					keep = k;
					break;
				}
			}
			if (!inThink) out += s.slice(0, s.length - keep);
			carry = s.slice(s.length - keep);
			return out;
		}
	};
}

const sseEvent = (event: string, data: unknown) =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const STOP_REASON: Record<string, string> = {
	length: "max_tokens",
	stop: "end_turn",
	tool_calls: "tool_use",
};
export const stopReason = (finish?: string): string =>
	(finish && STOP_REASON[finish]) || "end_turn";

export interface StreamMeta {
	id: string;
	model: string | undefined;
	routing?: Record<string, unknown>;
	/** W257: t0 = performance.now() at request receipt; openedAt = upstream
	 *  open; timings = pre-measured (buffered legs). With startedAt set the
	 *  tail's message_delta usage carries `_server_timings`. */
	startedAt?: number;
	openedAt?: number;
	timings?: RequestTimings;
}

function anthropicHead(meta: StreamMeta): string {
	return (
		sseEvent("message_start", {
			type: "message_start",
			message: {
				id: meta.id,
				type: "message",
				role: "assistant",
				model: meta.model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 0, output_tokens: 0 },
				...(meta.routing ? { _routing: meta.routing } : {}),
			},
		}) +
		sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})
	);
}

/** message_delta + message_stop (the tail after the last content block). */
function messageTail(
	stop: string | undefined,
	outTokens: number,
	timings?: RequestTimings,
): string {
	return (
		sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stop ?? "end_turn", stop_sequence: null },
			usage: {
				output_tokens: outTokens,
				...(timings ? { _server_timings: timings } : {}),
			},
		}) + sseEvent("message_stop", { type: "message_stop" })
	);
}

function anthropicTail(
	finish: string | undefined,
	outTokens: number,
	timings?: RequestTimings,
): string {
	return (
		sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
		messageTail(stopReason(finish), outTokens, timings)
	);
}

const textDelta = (text: string) =>
	sseEvent("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	});

/** A buffered answer (cloud escalation, fallback) as an Anthropic SSE stream,
 *  so stream:true clients always get the wire they asked for. */
export function anthropicSseFromText(
	text: string,
	meta: StreamMeta,
	finish?: string,
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(c) {
			c.enqueue(
				enc.encode(
					anthropicHead(meta) +
						textDelta(text) +
						anthropicTail(finish, 0, meta.timings),
				),
			);
			c.close();
		},
	});
}

interface OpenAiChunk {
	error?: unknown;
	choices?: Array<{
		delta?: {
			content?: string | null;
			/** W789: streaming tool calls — accumulated per OpenAI index. */
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: { completion_tokens?: number };
}

/** Translate an OpenAI chat-completions SSE body into Anthropic SSE, piping
 *  chunk by chunk (no buffering). `onDone` fires once with the totals. */
export function anthropicSseFromOpenAi(
	upstream: ReadableStream<Uint8Array>,
	meta: StreamMeta,
	onDone: (r: {
		chars: number;
		finish?: string;
		error?: string;
		timings?: RequestTimings;
	}) => void = () => {},
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const filter = thinkFilter();
	const semantics = new StreamSemantics();
	let buf = "";
	let chars = 0;
	let finish: string | undefined;
	let sourceFailure: string | undefined;
	let outTokens = 0;
	let finished = false;
	let ttftAt: number | undefined;
	// W789: anthropic block indices — 0 is the text block opened by the head;
	// each OpenAI tool index gets its own tool_use block from 1 up.
	const toolAcc = new Map<
		number,
		{ id: string; name: string; started: boolean }
	>();
	let blockIndex = 0;
	let textClosed = false;
	/** W257: `_server_timings` from t0/openedAt + the first-token mark; absent
	 *  (not zero) when the meta carries no t0. */
	const composeTimings = (): RequestTimings | undefined => {
		if (meta.startedAt === undefined) return undefined;
		const endAt = performance.now();
		return {
			total_ms: Math.round(endAt - meta.startedAt),
			prefill_ms: Math.round((meta.openedAt ?? endAt) - meta.startedAt),
			ttft_ms:
				ttftAt === undefined ? undefined : Math.round(ttftAt - meta.startedAt),
			decode_ms: ttftAt === undefined ? undefined : Math.round(endAt - ttftAt),
		};
	};
	const done = (error?: string, timings?: RequestTimings) => {
		if (finished) return;
		finished = true;
		onDone({ chars, finish, error, timings: timings ?? composeTimings() });
	};
	const handleLine = (line: string): string => {
		if (sourceFailure) return "";
		if (!line.startsWith("data:")) return "";
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return "";
		let j: OpenAiChunk;
		try {
			j = JSON.parse(data);
		} catch {
			return "";
		}
		if (j.error != null) {
			const error = upstreamErrorDetail(j);
			sourceFailure = String(error.code ?? error.type);
			return sseEvent("error", { type: "error", error });
		}
		if (j.usage?.completion_tokens) outTokens = j.usage.completion_tokens;
		const ch = j.choices?.[0];
		if (ch?.finish_reason) finish = ch.finish_reason;
		const tcs = ch?.delta?.tool_calls;
		if (tcs && tcs.length > 0) {
			const out: string[] = [];
			for (const tc of tcs) {
				const idx = tc.index ?? 0;
				let acc = toolAcc.get(idx);
				if (!acc) {
					acc = {
						id: tc.id ?? `call_${idx}`,
						name: tc.function?.name ?? "",
						started: false,
					};
					toolAcc.set(idx, acc);
				}
				if (tc.id) acc.id = tc.id;
				if (tc.function?.name) acc.name = tc.function.name;
				if (!acc.started) {
					if (!textClosed) {
						out.push(
							sseEvent("content_block_stop", {
								type: "content_block_stop",
								index: 0,
							}),
						);
						textClosed = true;
					}
					blockIndex += 1;
					acc.started = true;
					semantics.observe(
						{ content_block: { type: "tool_use", name: acc.name } },
						"anthropic",
					);
					out.push(
						sseEvent("content_block_start", {
							type: "content_block_start",
							index: blockIndex,
							content_block: {
								type: "tool_use",
								id: acc.id,
								name: acc.name,
								input: {},
							},
						}),
					);
				}
				if (tc.function?.arguments) {
					out.push(
						sseEvent("content_block_delta", {
							type: "content_block_delta",
							index: blockIndex,
							delta: {
								type: "input_json_delta",
								partial_json: tc.function.arguments,
							},
						}),
					);
				}
			}
			return out.join("");
		}
		const text = filter(ch?.delta?.content ?? "");
		if (!text) return "";
		if (textClosed) return ""; // text after tool blocks: dropped (wire order)
		if (ttftAt === undefined) ttftAt = performance.now();
		chars += text.length;
		semantics.observe({ delta: { text } }, "anthropic");
		return textDelta(text);
	};
	const reader = upstream.getReader();
	// W278: after cancel() the controller is closed — a pump enqueue throws,
	// the catch enqueues again, and that second throw escapes the void async
	// as an unhandled rejection (shim died on client aborts). One flag,
	// checked before every controller call.
	let clientGone = false;
	return new ReadableStream({
		start(c) {
			c.enqueue(enc.encode(anthropicHead(meta)));
			// PUSH-based: pump inside start() — Bun 1.4.x serve does not drive
			// pull()-based ReadableStream responses (verified 2026-10-03: pull()
			// never fires after start(); push-style pumping streams fine).
			void (async () => {
				try {
					for (;;) {
						const { value, done: eof } = await reader.read();
						if (eof) {
							const timings = composeTimings();
							const last = handleLine(buf);
							semantics.observe(
								{ delta: { stop_reason: stopReason(finish) } },
								"anthropic",
							);
							if (sourceFailure) {
								if (!clientGone) {
									if (last) c.enqueue(enc.encode(last));
									c.close();
								}
								done(sourceFailure, timings);
								return;
							}
							const failure = semantics.failure();
							if (failure) {
								if (!clientGone) {
									c.enqueue(
										enc.encode(
											last +
												sseEvent("error", {
													type: "error",
													error: emptyStreamError(failure),
												}),
										),
									);
									c.close();
								}
								done(failure, timings);
								return;
							}
							let tail = anthropicTail(finish, outTokens, timings);
							if (toolAcc.size > 0) {
								if (!textClosed)
									tail =
										sseEvent("content_block_stop", {
											type: "content_block_stop",
											index: 0,
										}) + tail;
								// close the last tool block before the message tail
								tail =
									sseEvent("content_block_stop", {
										type: "content_block_stop",
										index: blockIndex,
									}) + tail;
							}
							const out = last + tail;
							if (!clientGone) {
								c.enqueue(enc.encode(out));
								c.close();
							}
							done();
							return;
						}
						buf += dec.decode(value, { stream: true });
						const lines = buf.split("\n");
						buf = lines.pop() ?? "";
						const out = lines.map(handleLine).join("");
						if (out && !clientGone) c.enqueue(enc.encode(out));
						if (sourceFailure) {
							if (!clientGone) c.close();
							done(sourceFailure);
							await reader.cancel("upstream source error").catch(() => {});
							return;
						}
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (!clientGone) {
						c.enqueue(
							enc.encode(
								sseEvent("error", {
									type: "error",
									error: {
										type: "api_error",
										message: `router: upstream stream broke (${msg})`,
									},
								}),
							),
						);
						c.close();
					}
					done(msg);
				}
			})();
		},
		cancel(reason) {
			clientGone = true;
			done("client cancelled");
			return reader.cancel(reason);
		},
	});
}

export type RouteTarget = Pick<Specialist, "port" | "model">;
