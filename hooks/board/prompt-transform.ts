// hooks/board/prompt-transform.ts — W270 orchestrate prompt transforms.
// The prompt condenser (deterministic, clean-room), the optional local-LLM
// enhance pass (belt router :4000, Anthropic wire, graceful fallback), the
// injected-context disclosure and secret redaction for the debug/log
// preview. Pure module: no db, no board context — deps are injected so the
// unit tests drive every branch without a live board.
import { scrub } from "../lib/servicemon.ts";

// ─── settings (persisted in suspenders-board.json, W269-compatible keys) ──
export interface PromptSettings {
	"prompt.condense": boolean;
	"prompt.enhance": boolean;
	"prompt.debug": boolean;
	"prompt.log": boolean;
}

export const PROMPT_DEFAULTS: PromptSettings = {
	// W287: condense defaults OFF — the owner's call after review finding #4
	// (hedges carry meaning). The key stays so users can opt in.
	"prompt.condense": false,
	"prompt.enhance": false,
	"prompt.debug": false,
	"prompt.log": false,
};

export const PROMPT_KEYS = Object.keys(
	PROMPT_DEFAULTS,
) as (keyof PromptSettings)[];

export function resolvePromptSettings(
	stored: Partial<Record<keyof PromptSettings, unknown>>,
): PromptSettings {
	const out = { ...PROMPT_DEFAULTS };
	for (const k of PROMPT_KEYS)
		if (typeof stored[k] === "boolean") out[k] = stored[k] as boolean;
	return out;
}

// ─── the prompt condenser ────────────────────────────────────────────────
// Prose only: code fences, inline code, URLs and path-like tokens are
// protected verbatim. Rules are ordered and pure, so the same input always
// yields the same output, and condensing twice equals condensing once.

// [pattern, replacement] — W287 politeness-only ruleset: greetings, thanks,
// please/could-you wrappers and "go ahead and" add no instruction. Hedges,
// quantifiers and scope words (just, maybe, only, very, quite, perhaps,
// really, kind of…) carry meaning and are NEVER stripped. Imperative verbs
// and technical terms are never listed.
const FILLER: [RegExp, string][] = [
	[/^\s*(?:hi|hey|hello)(?: there)?\b[,!.]?/gim, ""],
	[
		/\b(?:thanks|thank you)(?: (?:so|very) much)?(?: in advance)?\b[,!.]?/gi,
		"",
	],
	[/\b(?:could|can|would) you (?:please )?(?:kindly )?\b/gi, ""],
	[/\b(?:please|kindly)\b[,]?/gi, ""],
	[/\bgo ahead and\b/gi, ""],
];

// fences, inline code, URLs, paths (/a/b, ./x, ~/x, a/b.ts), flags, dotted
// identifiers (prompt.condense) — the exact technical surface stays intact
const PROTECT =
	/```[\s\S]*?```|`[^`\n]+`|\bhttps?:\/\/\S+|(?:~|\.{1,2})?\/[\w.@~-]+(?:\/[\w.@~-]*)*|\b[\w-]+\/[\w./-]+|--?[A-Za-z][\w-]*|\b\w+(?:\.\w+)+\b/g;

function condenseProse(s: string): string {
	let t = s;
	for (const [re, rep] of FILLER) t = t.replace(re, rep);
	// doubled words ("the the"), case-insensitive, letters only
	return t.replace(/\b([A-Za-z]+)(\s+\1\b)+/gi, "$1");
}

function tidy(s: string): string {
	return s
		.replace(/([!?])\1+/g, "$1")
		.replace(/[ \t]+/g, " ")
		.replace(/ +([,.;:!?])/g, "$1")
		.replace(/([,;:])(?:\s*[,;:])+/g, "$1")
		.replace(/[,;:]+\s*([.!?])/g, "$1")
		.replace(/[,;:]+[ \t]*$/gm, "")
		.replace(/(^|[\n.!?]\s*)[,;:]\s*/g, "$1")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
}

// sentence-level redundancy: an exact (normalized) repeat of an earlier
// sentence adds nothing — drop it, keep the first occurrence
function dedupeSentences(s: string): string {
	const seen = new Set<string>();
	return s
		.split(/(?<=[.!?])\s+/)
		.filter((sent) => {
			const key = sent.toLowerCase().replace(/\W+/g, " ").trim();
			if (!key) return true;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.join(" ");
}

export function condensePrompt(text: string): string {
	const keep: string[] = [];
	// private-use sentinel: never typed by a human, survives every rule
	const masked = text.replace(PROTECT, (m) => {
		keep.push(m);
		return `\uE000${keep.length - 1}\uE001`;
	});
	const lines = masked
		.split("\n")
		.map((l) => dedupeSentences(condenseProse(l)));
	const out = tidy(lines.join("\n"))
		.split("\n")
		.map((l) => l.trim())
		.join("\n")
		.trim();
	return out.replace(/\uE000(\d+)\uE001/g, (_, i) => keep[Number(i)] ?? "");
}

// ─── enhance (opt-in local LLM rewrite) ──────────────────────────────────
export const ENHANCE_URL =
	process.env.SUSPENDERS_PROMPT_ENHANCE_URL ??
	"http://127.0.0.1:4000/v1/messages";
export const ENHANCE_MAX_TOKENS = 400;
export const ENHANCE_TIMEOUT_MS = 15_000;
export const ENHANCE_SYS =
	"Rewrite the user's task prompt for a coding-agent fleet so it is clearer and unambiguous. Keep every technical term, identifier, path and constraint exactly. Keep imperative voice. Do not add requirements, do not answer the task. Output ONLY the rewritten prompt.";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface EnhanceResult {
	text: string;
	ok: boolean;
	note: string;
	model: string;
	ms: number;
}

export async function enhancePrompt(
	text: string,
	opts: { model: string; url?: string; fetcher?: Fetcher; timeoutMs?: number },
): Promise<EnhanceResult> {
	const t0 = Date.now();
	const f = opts.fetcher ?? fetch;
	const done = (ok: boolean, out: string, note: string): EnhanceResult => ({
		text: out,
		ok,
		note,
		model: opts.model,
		ms: Date.now() - t0,
	});
	try {
		const r = await f(opts.url ?? ENHANCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: opts.model,
				max_tokens: ENHANCE_MAX_TOKENS,
				system: ENHANCE_SYS,
				messages: [{ role: "user", content: text }],
			}),
			signal: AbortSignal.timeout(opts.timeoutMs ?? ENHANCE_TIMEOUT_MS),
		});
		if (!r.ok)
			return done(false, text, `enhance skipped: router HTTP ${r.status}`);
		const j = (await r.json()) as {
			content?: { type?: string; text?: string }[];
		};
		const out = (j.content ?? [])
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("")
			.replace(/<think>[\s\S]*?<\/think>/gi, "")
			.trim();
		if (!out)
			return done(false, text, "enhance skipped: router returned no text");
		return done(true, out, "enhanced");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return done(
			false,
			text,
			`enhance skipped: router unreachable (${msg.slice(0, 120)})`,
		);
	}
}

// ─── secrets: never shown in the preview ─────────────────────────────────
const SECRET_PATTERNS: RegExp[] = [
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGN =
	/\b((?:api[_-]?key|secret|token|password|passwd|bearer|authorization)\s*[:=]?\s*)(["']?)[^\s"']{8,}\2/gi;

export function redactSecrets(text: string): string {
	let t = text;
	for (const re of SECRET_PATTERNS) t = t.replace(re, "[redacted]");
	t = t.replace(SECRET_ASSIGN, "$1[redacted]");
	return scrub(t);
}

// ─── the pipeline + disclosure ───────────────────────────────────────────
export interface Injection {
	label: string;
	text: string;
	bytes: number;
}

export interface PromptPlan {
	settings: PromptSettings;
	original: string;
	condensed: string | null;
	enhanced: string | null;
	enhanceNote: string | null;
	/** the goal text the fleet receives (before injected context) */
	final: string;
	injected: Injection[];
	/** the exact user message on the wire: final + appended context */
	wire: string;
}

export const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

export async function preparePrompt(
	goal: string,
	settings: PromptSettings,
	deps: {
		enhance?: (text: string) => Promise<EnhanceResult>;
		injections: { label: string; text: string }[];
		compose: (final: string) => string;
	},
): Promise<PromptPlan> {
	let cur = goal;
	let condensed: string | null = null;
	let enhanced: string | null = null;
	let enhanceNote: string | null = null;
	if (settings["prompt.condense"]) {
		condensed = condensePrompt(cur);
		// never condense a goal into nothing — the human's words win
		if (condensed) cur = condensed;
	}
	if (settings["prompt.enhance"] && deps.enhance) {
		const r = await deps.enhance(cur);
		enhanceNote = r.note;
		if (r.ok) {
			enhanced = r.text;
			cur = r.text;
		}
	}
	return {
		settings,
		original: goal,
		condensed,
		enhanced,
		enhanceNote,
		final: cur,
		injected: deps.injections.map((i) => ({ ...i, bytes: byteLen(i.text) })),
		wire: deps.compose(cur),
	};
}

// What the browser sees: debug = the final prompt only; log = every stage
// + every injection with byte counts. Secrets are redacted in all of it.
export function previewView(p: PromptPlan): Record<string, unknown> {
	const s = p.settings;
	const view: Record<string, unknown> = {
		settings: s,
		final: redactSecrets(p.final),
		finalBytes: byteLen(p.final),
		ran: {
			condense: p.condensed !== null,
			enhance: p.enhanced !== null,
		},
		enhanceNote: p.enhanceNote,
	};
	if (!s["prompt.log"]) return view;
	return {
		...view,
		stages: [
			{
				label: "original",
				text: redactSecrets(p.original),
				bytes: byteLen(p.original),
			},
			...(p.condensed !== null
				? [
						{
							label: "condensed",
							text: redactSecrets(p.condensed),
							bytes: byteLen(p.condensed),
						},
					]
				: []),
			...(p.enhanced !== null
				? [
						{
							label: "enhanced",
							text: redactSecrets(p.enhanced),
							bytes: byteLen(p.enhanced),
						},
					]
				: []),
		],
		injected: p.injected.map((i) => ({
			label: i.label,
			text: redactSecrets(i.text),
			bytes: i.bytes,
		})),
		wireBytes: byteLen(p.wire),
	};
}

// ─── preview → dispatch handoff ──────────────────────────────────────────
// The preview's exact plan is held server-side (bounded, TTL) so "dispatch"
// sends precisely what was previewed — the browser only carries an id and
// never needs the unredacted text back.
export interface HeldPlan {
	project: string;
	goal: string;
	final: string;
	ctx: string;
	at: number;
}
const HOLD_MAX = 32;
const HOLD_TTL_MS = 10 * 60_000;
const held = new Map<string, HeldPlan>();

export function holdPlan(p: Omit<HeldPlan, "at">, now = Date.now()): string {
	for (const [k, v] of held) if (now - v.at > HOLD_TTL_MS) held.delete(k);
	while (held.size >= HOLD_MAX) {
		const oldest = held.keys().next().value;
		if (oldest === undefined) break;
		held.delete(oldest);
	}
	const id = crypto.randomUUID();
	held.set(id, { ...p, at: now });
	return id;
}

// one-shot: a held plan dispatches once; a stale/mismatched id is ignored
// and the caller recomputes (the flow is never trapped by a lost preview)
export function takePlan(
	id: string,
	project: string,
	goal: string,
	now = Date.now(),
): HeldPlan | null {
	const h = held.get(id);
	if (!h) return null;
	held.delete(id);
	if (now - h.at > HOLD_TTL_MS || h.project !== project || h.goal !== goal)
		return null;
	return h;
}
