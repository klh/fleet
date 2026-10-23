// oracle-legs.ts — W742.2: the two oracle legs as a library, one source of
// truth for the pinned local-reason leg and the cloud escalation leg
// (extracted verbatim from oracle.ts so the advise panel mode fans the SAME
// wires). W1119.1: both legs ride the ONE shared gated Buckle client
// (inference-buckle.ts) — no direct :890x/:4000 endpoint, no provider
// fallback; fail closed. The legs differ only in their W136 hint selector
// and default model pin, and the preference stays DATA (config-over-code):
//   ORACLE_ROUTE_MODEL   pinned-leg model id pin (else "local-reason")
import { buckleChat } from "./inference-buckle.ts";

export const PINNED_MODEL = "local-reason";
export const CLOUD_MODEL = "glm-5.3";
export const PINNED_HINT = "prefer local reasoning";
export const CLOUD_HINT = "prefer cloud";

export type LegDeps = { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch };

export type LegResult = {
	text: string;
	model: string;
	ms: number;
	pt: number;
	ct: number;
};

export const ORACLE_SYSTEM =
	"You are oracle — a stateless escalation surface. One request, one answer.";

/** The pinned local-reason leg through the gated Buckle client. Throws on
 *  absent gate config or a non-2xx answer — the caller surfaces the error. */
export const pinnedLeg = async (
	prompt: string,
	maxTokens: number,
	timeoutMs: number,
	deps: LegDeps = {},
): Promise<LegResult> => {
	const r = await buckleChat(
		{
			model:
				(deps.env ?? process.env).ORACLE_ROUTE_MODEL?.trim() || PINNED_MODEL,
			system: ORACLE_SYSTEM,
			user: prompt,
			maxTokens,
			temperature: 0.2,
			timeoutMs,
			hint: PINNED_HINT,
			...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
		},
		deps.env ?? process.env,
	);
	const text = r.text.trim();
	if (text === "") throw new Error("route answered with no content");
	return { text, model: r.model, ms: r.ms, pt: r.pt, ct: r.ct };
};

/** The cloud escalation leg through the SAME gated client — the stronger
 *  route rides as the W136 hint + the glm-5.3 default model pin. */
export const cloudLeg = async (
	prompt: string,
	maxTokens: number,
	deps: LegDeps = {},
): Promise<LegResult> => {
	const r = await buckleChat(
		{
			model: CLOUD_MODEL,
			user: prompt,
			maxTokens,
			hint: CLOUD_HINT,
			...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
		},
		deps.env ?? process.env,
	);
	const text = r.text.trim();
	if (text === "") throw new Error("cloud leg returned no text");
	return { text, model: r.model, ms: r.ms, pt: r.pt, ct: r.ct };
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
	pt: number;
	ct: number;
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
				pt: s.value.pt,
				ct: s.value.ct,
				verdict: verdictOf(s.value.text),
				text: s.value.text,
			};
		return {
			name,
			ok: false,
			model: name,
			ms: 0,
			pt: 0,
			ct: 0,
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
