// hooks/lib/kev.ts — kev-class typed-decision models (W225 token-efficiency
// lever). The control plane's typed decisions (NEED% forks carrying
// payload.options, and the board's decision re-evaluate) ask a kev-class
// server FIRST: typed questions in, typed answers out, ONE prefill pass
// (~70 input tokens, zero marginal cost locally) — and fall through to the
// chat-LLM chain (belt → swarm → z.ai) on ANY failure. kev itself is a
// launchd service (com.klh.kev) on :8912; the class is the systemone
// protocol, not the box — SUSPENDERS_KEV_URL stands any systemone-speaking
// endpoint in for it.
//
// The client NEVER throws: every failure mode (down, timeout, malformed,
// fewer than two options, model answer outside the option set) returns null
// and the caller keeps its existing fallback chain untouched. Timeout is
// kev-cold generous (the 4B model can take ~40s to answer when cold).
//
// Live contract (kev 0.1.0, verified 2026-10-03 against com.klh.kev):
//   POST /v1/systemone {state, questions: {d: {type: "choice",
//     instructions, criteria: {<option>: <description>}}}}
//   → {model, answers: {d: {type, choice, confidence, probabilities}},
//      usage: {input_tokens, output_tokens}, latency_ms}

export const KEV_DEFAULT_URL = "http://127.0.0.1:8912";
const KEV_TIMEOUT_MS = 120_000;

export interface KevOption {
	label: string;
	tradeoff?: string | null;
}

export interface KevDecision {
	model: string;
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
}

/** Resolved kev-class endpoint: env override, else the same-box launchd
 *  service. Mirrors the belt-locate idiom (env → default; callers degrade
 *  when nothing answers). */
export function kevUrl(): string {
	return process.env.SUSPENDERS_KEV_URL?.replace(/\/$/, "") ?? KEV_DEFAULT_URL;
}

/** Fork payload options → the typed-decision option set (consumer-side
 *  parse of the normOptions storage contract, hooks/board/lanes.ts: real
 *  array, JSON-encoded array string, or the CLI "a | b" ergonomics). */
export function parseOptions(v: unknown): KevOption[] {
	if (typeof v === "string" && v.trimStart().startsWith("[")) {
		try {
			v = JSON.parse(v);
		} catch {}
	}
	if (typeof v === "string") {
		const labels = v.split(/\s*\|\s*/).filter(Boolean);
		if (labels.length > 1) v = labels;
	}
	if (!Array.isArray(v)) return [];
	return v
		.map((o) =>
			typeof o === "string"
				? { label: String(o).trim() }
				: {
						label: String(o?.label ?? "").trim(),
						tradeoff: o?.tradeoff == null ? null : String(o.tradeoff),
					},
		)
		.filter((o) => o.label.length > 0);
}

/** One typed decision pass: a choice question over the caller's options.
 *  Null on any failure — the caller's fallback chain is the contract. */
export async function kevTypedDecision(input: {
	state: string;
	question: string;
	options: KevOption[];
}): Promise<KevDecision | null> {
	const options = input.options.filter((o) => o.label?.trim());
	if (options.length < 2) return null; // a choice needs a choice
	const criteria = Object.fromEntries(
		options.map((o) => [o.label.trim(), o.tradeoff?.trim() || o.label.trim()]),
	);
	try {
		const r = await fetch(`${kevUrl()}/v1/systemone`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				state: input.state.slice(0, 4000),
				questions: {
					d: {
						type: "choice",
						instructions: input.question.slice(0, 4000),
						criteria,
					},
				},
			}),
			signal: AbortSignal.timeout(KEV_TIMEOUT_MS),
		});
		if (!r.ok) return null;
		const j = (await r.json()) as {
			model?: string;
			answers?: Record<
				string,
				{
					choice?: string;
					confidence?: number;
					probabilities?: Record<string, number>;
				}
			>;
			usage?: { input_tokens?: number; output_tokens?: number };
			latency_ms?: number;
		};
		const a = j.answers?.d;
		// the typed answer must be one of the offered options — anything else
		// is a malformed pass and the chat chain does better
		if (!a?.choice || !a.probabilities || !(a.choice in a.probabilities))
			return null;
		return {
			model: j.model ?? "kev-latest",
			choice: a.choice,
			confidence: a.confidence ?? a.probabilities[a.choice] ?? 0,
			probabilities: a.probabilities,
			inputTokens: j.usage?.input_tokens ?? 0,
			outputTokens: j.usage?.output_tokens ?? 0,
			latencyMs: j.latency_ms ?? 0,
		};
	} catch {
		return null;
	}
}

/** Probabilities sorted best-first, "label 27%" lines — the shared rendering
 *  for the advice card and the eval feed. */
export function kevProbabilityLines(d: KevDecision): string[] {
	return Object.entries(d.probabilities)
		.sort((a, b) => b[1] - a[1])
		.map(([label, p]) => `${label} ${Math.round(p * 100)}%`);
}
