// prompt-bench-client.ts — W368 bench HTTP legs. Mirrors the production
// transform client (hooks/board/prompt-transform.ts): max_tokens 400, the
// verbatim ENHANCE_SYS, <think> strip, honest per-leg failure records
// (no retries — a failed leg is data, not something to hide).
import { ENHANCE_SYS } from "../../hooks/board/prompt-transform.ts";

export const BENCH_TIMEOUT_MS = 90_000;

export interface LegResult {
	ok: boolean;
	text: string;
	wallMs: number;
	note: string;
	/** router leg: the _routing.port that actually served, when known */
	servedPort: number | null;
}

export const stripThink = (t: string): string =>
	t
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.trim();

const nonceTag = (nonce: string): string => `\n\n[bench nonce ${nonce}]`;

/** OpenAI-wire leg against a loopback specialist (:890x direct tier —
 *  the exact path resolveEnhanceTarget takes in production). */
export async function callDirect(opts: {
	base: string;
	model: string;
	system: string;
	user: string;
	nonce: string;
	maxTokens?: number;
	timeoutMs?: number;
}): Promise<LegResult> {
	const t0 = Date.now();
	const done = (ok: boolean, text: string, note: string): LegResult => ({
		ok,
		text,
		wallMs: Date.now() - t0,
		note,
		servedPort: null,
	});
	try {
		const r = await fetch(`${opts.base.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: opts.model,
				max_tokens: opts.maxTokens ?? 400,
				messages: [
					{ role: "system", content: opts.system },
					{ role: "user", content: opts.user + nonceTag(opts.nonce) },
				],
			}),
			signal: AbortSignal.timeout(opts.timeoutMs ?? BENCH_TIMEOUT_MS),
		});
		if (!r.ok) return done(false, "", `HTTP ${r.status}`);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = stripThink(String(j.choices?.[0]?.message?.content ?? ""));
		if (!text) return done(false, "", "empty");
		return done(true, text, "ok");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return done(false, "", `unreachable (${msg.slice(0, 120)})`);
	}
}

/** Anthropic-wire leg through the belt router :4000 — the stack path.
 *  Placement is the router's own decision; _routing.port is recorded. */
export async function callRouter(opts: {
	url: string;
	system: string;
	user: string;
	nonce: string;
	maxTokens?: number;
	timeoutMs?: number;
}): Promise<LegResult> {
	const t0 = Date.now();
	const done = (ok: boolean, text: string, note: string): LegResult => ({
		ok,
		text,
		wallMs: Date.now() - t0,
		note,
		servedPort: null,
	});
	try {
		const r = await fetch(opts.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4",
				max_tokens: opts.maxTokens ?? 400,
				system: opts.system,
				messages: [{ role: "user", content: opts.user + nonceTag(opts.nonce) }],
			}),
			signal: AbortSignal.timeout(opts.timeoutMs ?? BENCH_TIMEOUT_MS),
		});
		if (!r.ok) return done(false, "", `HTTP ${r.status}`);
		const j = (await r.json()) as {
			content?: { type?: string; text?: string }[];
			_routing?: { port?: number };
		};
		const text = stripThink(
			(j.content ?? [])
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join(""),
		);
		if (!text) return done(false, "", "empty");
		return {
			ok: true,
			text,
			wallMs: Date.now() - t0,
			note: "ok",
			servedPort: j._routing?.port ?? null,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return done(false, "", `unreachable (${msg.slice(0, 120)})`);
	}
}

export const COMPRESS_SYS =
	"Compress the user's prompt for a coding-agent fleet. Keep every file path, command, flag, identifier, number and constraint exactly. Remove politeness and filler. Output ONLY the compressed prompt.";

export { ENHANCE_SYS as PROD_ENHANCE_SYS };
