// oracle-legs.ts — W742.2: the two oracle legs as a library, one source of
// truth for the pinned :8903 leg and the cloud escalation leg (extracted
// verbatim from oracle.ts so the advise panel mode fans the SAME wires).
// The pinned leg is a direct OpenAI-wire POST — never router-classified,
// never belt-role-dispatched; the cloud leg rides the :4000 router's own
// escalation leg (belt/bin/escalate.ts — buckle-gate when BELT_ESCALATE_* is
// set, legacy settings.json creds otherwise).
// env (config-over-code; defaults name the pinned fleet routes):
//   ORACLE_ROUTE_URL   default http://127.0.0.1:8903/v1/chat/completions
//   ORACLE_ROUTE_KEY   optional bearer for the pinned leg
//   ORACLE_ROUTE_MODEL optional model id (else GET /models probe, else "local")
import { escalate, resolveEscalationLeg } from "../../../belt/bin/escalate.ts";
import type { AnthropicBody } from "../../../belt/bin/router-core.ts";

export const ROUTE_URL =
	process.env.ORACLE_ROUTE_URL ?? "http://127.0.0.1:8903/v1/chat/completions";
export const ROUTE_KEY = process.env.ORACLE_ROUTE_KEY;
export const ROUTE_MODEL = process.env.ORACLE_ROUTE_MODEL;

// no model configured → ask the endpoint what it serves (first entry); works
// for the MLX server, llama.cpp, vLLM, or any OpenAI-compatible shim
const probeModel = async (
	url: string,
	key: string | undefined,
): Promise<string> => {
	try {
		const r = await fetch(url.replace(/\/chat\/completions$/, "/models"), {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		const j = (await r.json()) as { data?: { id: string }[] };
		return j.data?.[0]?.id ?? "local";
	} catch {
		return "local";
	}
};

const legModel = (): Promise<string> =>
	ROUTE_MODEL ?? probeModel(ROUTE_URL, ROUTE_KEY);

const wireHeaders = (key: string | undefined): Record<string, string> => ({
	"content-type": "application/json",
	...(key ? { authorization: `Bearer ${key}` } : {}),
});

const wireBody = (model: string, prompt: string, maxTokens: number): string =>
	JSON.stringify({
		model,
		messages: [
			{
				role: "system",
				content:
					"You are oracle — a stateless escalation surface. One request, one answer.",
			},
			{ role: "user", content: prompt },
		],
		max_tokens: maxTokens,
		temperature: 0.2,
	});

async function readLeg(
	r: Response,
	model: string,
	t0: number,
): Promise<LegResult> {
	if (!r.ok)
		throw new Error(`route ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = (await r.json()) as {
		choices?: { message?: { content?: string }[] };
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const text = (j.choices?.[0]?.message?.content ?? "").trim();
	if (text === "") throw new Error("route answered with no content");
	return {
		text,
		model,
		ms: Date.now() - t0,
		promptTok: j.usage?.prompt_tokens,
		compTok: j.usage?.completion_tokens,
	};
}

export type LegResult = {
	text: string;
	model: string;
	ms: number;
	// wire usage when the leg reports it (W776 attribution on consult legs)
	promptTok?: number;
	compTok?: number;
};

// the OpenAI-wire leg for ANY pinned endpoint — W927: the consult pool's
// coder :8901 / danish :8906 legs ride the same wire as the :8903 default
export const wireLeg = async (
	url: string,
	key: string | undefined,
	prompt: string,
	maxTokens: number,
	timeoutMs: number,
	forcedModel?: string,
): Promise<LegResult> => {
	const model = forcedModel ?? (await probeModel(url, key));
	const t0 = Date.now();
	const r = await fetch(url, {
		method: "POST",
		headers: wireHeaders(key),
		body: wireBody(model, prompt, maxTokens),
		signal: AbortSignal.timeout(timeoutMs),
	});
	return readLeg(r, model, t0);
};

export const pinnedLeg = async (
	prompt: string,
	maxTokens: number,
	timeoutMs: number,
): Promise<LegResult> => {
	const model = await legModel();
	const t0 = Date.now();
	const r = await fetch(ROUTE_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(ROUTE_KEY ? { authorization: `Bearer ${ROUTE_KEY}` } : {}),
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "system",
					content:
						"You are oracle — a stateless escalation surface. One request, one answer.",
				},
				{ role: "user", content: prompt },
			],
			max_tokens: maxTokens,
			temperature: 0.2,
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!r.ok)
		throw new Error(`route ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = (await r.json()) as {
		choices?: { message?: { content?: string }[] };
	};
	const text = (j.choices?.[0]?.message?.content ?? "").trim();
	if (text === "") throw new Error("route answered with no content");
	return { text, model, ms: Date.now() - t0 };
};

export const cloudLeg = async (
	prompt: string,
	maxTokens: number,
): Promise<LegResult> => {
	const leg = await resolveEscalationLeg(process.env);
	if (!leg)
		throw new Error(
			"no cloud leg configured — set BELT_ESCALATE_URL/KEY (or legacy settings.json creds)",
		);
	const body: AnthropicBody = { messages: [{ role: "user", content: prompt }] };
	const t0 = Date.now();
	const r = await escalate(body, { maxTokens, wantFast: false });
	const text = r.text.trim();
	if (text === "")
		throw new Error(
			`cloud leg ${leg.mode} returned no text (status ${r.status ?? "?"})${
				r.retryAfterMs ? ` — retry-after ${r.retryAfterMs}ms` : ""
			}`,
		);
	return { text, model: r.model, ms: Date.now() - t0 };
};

// W742.2: the panel verdict vocabulary — approve | hold | reject (decision
// words, machine-parseable final line); oracle's FRAMES.panel rides it too
export const PANEL_FRAME = [
	"You are a read-only decision advisor (oracle fixed contract). A NEED_DECISION fork needs an independent read.",
	"Weigh the options, name the strongest counter-argument, then decide.",
	"Include a line RECOMMENDATION: <one concrete decision the operator can send verbatim>. A title or analysis heading is not a recommendation.",
	"End your reply with ONE machine-parseable final line:",
	"VERDICT: approve | VERDICT: hold - <what would change it> | VERDICT: reject - <why>",
].join("\n");

export const verdictOf = (text: string): string | null => {
	const m = text.match(/^VERDICT:\s*([a-z]+)/im);
	return m?.[1]?.toLowerCase() ?? null;
};

export type PanelRow = {
	name: string;
	ok: boolean;
	model: string;
	ms: number;
	verdict: string | null;
	text: string;
	error?: string;
};

export const buildPanelRows = (
	settled: PromiseSettledResult<LegResult>[],
): PanelRow[] =>
	settled.map((s, i) => {
		const name = i === 0 ? "local-reason" : "cloud";
		if (s.status === "fulfilled")
			return {
				name,
				ok: true,
				model: s.value.model,
				ms: s.value.ms,
				verdict: verdictOf(s.value.text),
				text: s.value.text,
			};
		return {
			name,
			ok: false,
			model: name,
			ms: 0,
			verdict: null,
			text: "",
			error: s.reason instanceof Error ? s.reason.message : String(s.reason),
		};
	});

// Consensus requires both independent legs to return a parsed verdict.
export const consensusOf = (rows: PanelRow[]): string => {
	const verdicts = rows.flatMap((r) => (r.ok && r.verdict ? [r.verdict] : []));
	const unique = [...new Set(verdicts)];
	return verdicts.length === 0
		? "no verdicts"
		: verdicts.length < rows.length
			? `single review: ${verdicts[0]}`
			: unique.length === 1
				? `consensus ${unique[0]}`
				: `split ${verdicts.join(" vs ")}`;
};
