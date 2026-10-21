// hooks/lib/inference-buckle.ts — W1119, decision.single-buckle-inference:
// the ONE Suspenders inference boundary. Every model call the control plane
// makes (board orch/suggest/enhance, advise, oracle, decision eval, Kev)
// resolves its Buckle route HERE — endpoint + scoped bksk_ key + traceparent
// + absolute deadline — and POSTs through the gate. No direct :890x/:4000/
// :4100/provider endpoint, no unauthenticated fallback: absent or unsafe
// config throws (fail closed — the caller surfaces the error, it never
// reroutes solo). Model preference stays request metadata (the x-belt-hint
// header grammar); a preference never names an endpoint. The credential is
// the knowledge-buckle contract: the SUSPENDERS_BUCKLE_URL/SUSPENDERS_
// BUCKLE_TOKEN pair or the 0600 machine-local knowledge-buckle.json.
import { knowledgeBuckleRoute } from "./knowledge-buckle.ts";

export const BUCKLE_MESSAGES_PATH = "/v1/messages";
export const BUCKLE_CHAT_PATH = "/v1/chat/completions";
/** buckle's response-identity header (telemetry/src/http-trace.ts
 *  OWNED_HEADERS — a 32-hex trace id, not a W3C traceparent). */
export const TRACE_ID_HEADER = "x-klh-trace-id";
// W136 hint grammar lives in buckle (src/hints.ts) — ≤512 bytes on the wire,
// exactly one header; buckle rejects malformed hints server-side, so the
// client only bounds the byte length.
export const HINT_HEADER = "x-belt-hint";
export const HINT_MAX_BYTES = 512;

export interface InferenceBuckleRoute {
	base: URL;
	token: string;
}

/** Fail-closed route resolution: throws when Buckle or the scoped key is
 *  unavailable — callers surface the error, never fall back solo. */
export function inferenceBuckleRoute(
	env: NodeJS.ProcessEnv = process.env,
): InferenceBuckleRoute {
	const { front, token } = knowledgeBuckleRoute(env);
	return { base: front, token };
}

/** Headers for one gated inference call. Both credential forms ride (belt
 *  :4000 ignores them; buckle accepts either). `hint` is the W136 selector
 *  string ('prefer local reasoning'); `traceparent` the W461 trace context. */
export function inferenceHeaders(opts: {
	token: string;
	wire: "anthropic" | "openai";
	hint?: string;
	traceparent?: string;
}): Record<string, string> {
	const hint = opts.hint ?? "";
	if (Buffer.byteLength(hint, "utf8") > HINT_MAX_BYTES)
		throw new Error(`hint exceeds ${HINT_MAX_BYTES} bytes`);
	return {
		"content-type": "application/json",
		...(opts.wire === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
		authorization: `Bearer ${opts.token}`,
		"x-api-key": opts.token,
		...(hint ? { [HINT_HEADER]: hint } : {}),
		...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
	};
}

export interface BuckleChatRequest {
	model: string;
	system?: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	hint?: string;
	traceparent?: string;
	/** LOCAL wall-clock budget only (the AbortSignal). The repo has no
	 *  established cross-hop deadline header yet (owner note 2026-10-21) —
	 *  cross-hop propagation coordinates with W1118/W1117/W1086 before any
	 *  wire format lands. */
	timeoutMs?: number;
	wire?: "anthropic" | "openai";
	fetcher?: typeof fetch;
}

export interface BuckleChatResult {
	text: string;
	model: string;
	ms: number;
	/** buckle's response identity (x-klh-trace-id), null when absent */
	traceId: string | null;
}

/** One gated chat call. Throws on absent config or a non-2xx/timed-out gate
 *  (fail closed — the error is the caller's to surface; no solo reroute).
 *  Errors carry bounded status + trace identity only — never the upstream
 *  body, which can echo prompt/key material. */
export async function buckleChat(
	req: BuckleChatRequest,
	env: NodeJS.ProcessEnv = process.env,
): Promise<BuckleChatResult> {
	const { base, token } = inferenceBuckleRoute(env);
	const t0 = Date.now();
	const wire = req.wire ?? "anthropic";
	const openai = wire === "openai";
	const body = openai
		? {
				model: req.model,
				max_tokens: req.maxTokens ?? 500,
				temperature: req.temperature,
				messages: [
					...(req.system ? [{ role: "system", content: req.system }] : []),
					{ role: "user", content: req.user },
				],
			}
		: {
				model: req.model,
				max_tokens: req.maxTokens ?? 500,
				temperature: req.temperature,
				system: req.system,
				messages: [{ role: "user", content: req.user }],
			};
	let res: Response;
	try {
		res = await (req.fetcher ?? fetch)(
			`${base.origin}${openai ? BUCKLE_CHAT_PATH : BUCKLE_MESSAGES_PATH}`,
			{
				method: "POST",
				headers: inferenceHeaders({
					token,
					wire,
					hint: req.hint,
					traceparent: req.traceparent,
				}),
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
			},
		);
	} catch (error) {
		throw new Error(
			`buckle inference unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const traceId = res.headers.get(TRACE_ID_HEADER);
	if (!res.ok)
		throw new Error(
			`buckle inference HTTP ${res.status} (trace ${traceId ?? "none"})`,
		);
	const j = (await res.json()) as {
		content?: { type?: string; text?: string }[];
		choices?: { message?: { content?: string } }[];
		model?: string;
	};
	const text = openai
		? (j.choices?.[0]?.message?.content ?? "")
		: (j.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("") ?? "");
	return {
		text,
		model: j.model ?? req.model,
		ms: Date.now() - t0,
		traceId,
	};
}
