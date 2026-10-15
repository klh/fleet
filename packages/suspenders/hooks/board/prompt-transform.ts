// hooks/board/prompt-transform.ts — W270 orchestrate prompt transforms.
// The prompt condenser (deterministic, clean-room), the optional local-LLM
// enhance pass (belt router :4000, Anthropic wire, graceful fallback), the
// injected-context disclosure and secret redaction for the debug/log
// preview. Pure module: no db, no board context — deps are injected so the
// unit tests drive every branch without a live board.
import { readFileSync } from "node:fs";
import { condenseTier } from "@klh/blam/src/condense/tiers.ts";
import { scrub } from "../lib/servicemon.ts";

// ─── settings (persisted in suspenders-board.json, W269-compatible keys) ──
export interface PromptSettings {
	"prompt.condense": boolean;
	"prompt.enhance": boolean;
	"prompt.debug": boolean;
	"prompt.log": boolean;
}

export const PROMPT_DEFAULTS: PromptSettings = {
	// Owner reversal 2026-10-03: condense is ON by default — the W287
	// politeness-only ruleset stands (hedges/quantifiers/scope words are never
	// touched; meaning survives), users turn it off per settings.
	"prompt.condense": true,
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

// ─── the prompt condenser (W367.2: blam canonical engine) ────────────────
// The inline W287/W334 ruleset moved to the blam canonical engine
// (packages/blam/src/condense/{engine,tiers,version}.ts) — this is now a
// pure delegation to the `caveman` tier, whose rule table reproduces the
// old pipeline exactly (W287 politeness filler, W334 meta-sentence strip,
// jaccard sentence dedupe, tidy chain). Prose only: code fences, inline
// code, URLs and path-like tokens stay verbatim; deterministic and
// idempotent. Byte parity is pinned in pins.json
// (packages/blam/test/fixtures/condense/, 25-input corpus,
// blam-condense/1) — change the tier table there, never here.
export function condensePrompt(text: string): string {
	return condenseTier("caveman", text).text;
}

// ─── enhance (opt-in local LLM rewrite) ──────────────────────────────────
// W288: the default target is a belt DIRECT TIER by registry alias —
// local-extract (:8902), local-reason (:8903) as the heavier fallback —
// resolved from belt's EMITTED direct-tiers.json (the gateway-config
// emission; never a YAML re-parse). Loopback-validated + OpenAI wire + no
// complexity router: the goal text cannot escalate off-box, and telemetry
// records the alias that actually served. Operator pins keep gateway mode
// (buckle front, Anthropic wire): SUSPENDERS_PROMPT_ENHANCE_URL /
// SUSPENDERS_PROMPT_MODEL; SUSPENDERS_PROMPT_ENHANCE_KEY carries the
// operator-minted scoped key (buckle:proxy:WRITE_ — never the admin key).
// A down specialist / closed gate / absent key → the enhance pass honestly
// skips (same graceful fallback as any router error); the goal text is
// never lost to an enhancement outage.
export const ENHANCE_URL =
	process.env.SUSPENDERS_PROMPT_ENHANCE_URL ??
	"http://127.0.0.1:4101/v1/messages";
export const ENHANCE_KEY = process.env.SUSPENDERS_PROMPT_ENHANCE_KEY ?? "";
export const ENHANCE_MAX_TOKENS = 400;
export const ENHANCE_TIMEOUT_MS = 15_000;
export const ENHANCE_SYS =
	"Rewrite the user's task prompt for a coding-agent fleet so it is clearer and unambiguous. Keep every technical term, identifier, path and constraint exactly. Keep imperative voice. Do not add requirements, do not answer the task. Output ONLY the rewritten prompt.";

// W288 — default alias preference: extract first (registry good_at: "fast
// cheap drafting"; the 2.5 GB row stays resident even on minimal-tier
// machines), reason only as the heavier fallback.
export const ENHANCE_DIRECT_ALIASES = ["local-extract", "local-reason"];

// belt's emitted alias → loopback base map (gateway-config.ts emission)
const DIRECT_TIERS_PATH = () =>
	`${
		process.env.SUSPENDERS_HOME ?? process.env.HOME
	}/.claude/local-llm/direct-tiers.json`;

// parseDirect (belt bin/router-policy.ts) only ever emits loopback http
// bases — re-validate on read: the file is data, trust nothing.
const LOOPBACK =
	/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}(\/v1)?\/?$/;

export interface EnhanceTarget {
	mode: "direct" | "gateway";
	alias: string;
	/** the real serving model id (live-probed for direct tiers — the alias
	 *  is the POLICY key, the id is what the specialist serves) */
	model: string;
	url: string;
	wire: "openai" | "anthropic";
}

/** W288 — the enhance target, resolved once per call:
 *  SUSPENDERS_PROMPT_MODEL pin → gateway with the pinned model;
 *  SUSPENDERS_PROMPT_ENHANCE_URL pin → gateway on the pinned endpoint
 *  (model = the direct alias, an honest id); else the first direct-tier
 *  alias whose specialist answers /v1/models (OpenAI wire, loopback) —
 *  the live id rides the wire and the result records it; nothing
 *  resolvable → the buckle-front default with the alias as the id. */
export async function resolveEnhanceTarget(deps?: {
	readFile?: (path: string) => string;
	probe?: (base: string) => Promise<string | null>;
}): Promise<EnhanceTarget> {
	const modelPin = process.env.SUSPENDERS_PROMPT_MODEL;
	const urlPin = process.env.SUSPENDERS_PROMPT_ENHANCE_URL;
	const read = deps?.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const probe =
		deps?.probe ??
		(async (base: string): Promise<string | null> => {
			try {
				const r = await fetch(`${base}/models`, {
					signal: AbortSignal.timeout(3000),
				});
				if (!r.ok) return null;
				const j = (await r.json()) as { data?: { id?: string }[] };
				return j.data?.[0]?.id ?? null;
			} catch {
				return null;
			}
		});
	if (modelPin)
		return {
			mode: "gateway",
			alias: "",
			model: modelPin,
			url: urlPin ?? ENHANCE_URL,
			wire: "anthropic",
		};
	if (urlPin)
		return {
			mode: "gateway",
			alias: "",
			model: ENHANCE_DIRECT_ALIASES[0],
			url: urlPin,
			wire: "anthropic",
		};
	try {
		const doc = JSON.parse(read(DIRECT_TIERS_PATH())) as Record<
			string,
			unknown
		>;
		for (const alias of ENHANCE_DIRECT_ALIASES) {
			const base = doc[alias];
			if (typeof base !== "string" || !LOOPBACK.test(base)) continue;
			const id = await probe(base);
			if (!id) continue;
			return {
				mode: "direct",
				alias,
				model: id,
				url: `${base.replace(/\/$/, "").replace(/(\/v1)?$/, "/v1")}/chat/completions`,
				wire: "openai",
			};
		}
	} catch {
		// no map / unreadable → the gateway default below
	}
	return {
		mode: "gateway",
		alias: "",
		model: ENHANCE_DIRECT_ALIASES[0],
		url: ENHANCE_URL,
		wire: "anthropic",
	};
}

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
	opts: {
		model: string;
		url?: string;
		key?: string;
		wire?: "openai" | "anthropic";
		fetcher?: Fetcher;
		timeoutMs?: number;
	},
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
	const key = opts.key ?? ENHANCE_KEY;
	const endpoint = opts.url ?? ENHANCE_URL;
	const openai = (opts.wire ?? "anthropic") === "openai";
	try {
		const r = await f(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				// anthropic-version rides the anthropic wire only; direct tiers
				// are loopback + keyless (no credential on the openai wire)
				...(openai ? {} : { "anthropic-version": "2023-06-01" }),
				// gate credentials: the scoped bksk_ key, both wire forms (belt
				// :4000 ignores them; buckle accepts either)
				...(openai || !key
					? {}
					: { "x-api-key": key, authorization: `Bearer ${key}` }),
			},
			body: openai
				? JSON.stringify({
						model: opts.model,
						max_tokens: ENHANCE_MAX_TOKENS,
						messages: [
							{ role: "system", content: ENHANCE_SYS },
							{ role: "user", content: text },
						],
					})
				: JSON.stringify({
						model: opts.model,
						max_tokens: ENHANCE_MAX_TOKENS,
						system: ENHANCE_SYS,
						messages: [{ role: "user", content: text }],
					}),
			signal: AbortSignal.timeout(opts.timeoutMs ?? ENHANCE_TIMEOUT_MS),
		});
		if (!r.ok)
			return done(false, text, `enhance skipped: router HTTP ${r.status}`);
		const j = await r.json();
		const raw = openai
			? String(
					(j as { choices?: { message?: { content?: string } }[] }).choices?.[0]
						?.message?.content ?? "",
				)
			: ((j as { content?: { type?: string; text?: string }[] }).content ?? []);
		const out = (
			openai
				? raw
				: (raw as { type?: string; text?: string }[])
						.filter((c) => c.type === "text" && typeof c.text === "string")
						.map((c) => c.text)
						.join("")
		)
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
