// hooks/lib/lanes/lane-done-spend.ts — W1070: the self-reported spend block a
// closing session can stamp onto `work done`. Session-subagent work rides the
// parent session's own connection — no per-lane bksk_ key, no router_usage
// rows — so the buckle-ledger join (lane-spend.ts) legitimately finds zero
// and the report dashes TOKENS/CACHE/MODEL. The close computes its own spend
// from its transcript (assistant usage lines) and hands it here: `--spend
// fresh=123,cache=4560,out=789,model=glm-5.3-flash`. The stamp rides the
// work.done event payload (the W909 effort-stamp pattern) and itemAttribution
// replays it as fallback attribution when no ledger rows attribute — dashes
// stay the honest "no data anywhere" signal, never a subagent hole.
// Group detail is intentionally collapsed to ONE model group: the report's
// MODEL column renders the top group, and a closing session naming several
// groups mis-attributes anyway (in-time overlap, not causality — the W635
// honesty rule).

export interface DoneSpend {
	fresh: number;
	cached: number;
	out: number;
	model: string;
}

/** Parse the --spend value: comma-set `k=v` pairs, k ∈ fresh|cache|out|model
 *  (aliases cached|cache_read|cache_in → cached, input|prompt → fresh).
 *  Numbers are plain integers; negative/garbage values refuse (null) — a
 *  bad stamp must never land as fake data. model truncated at 24 chars.
 *  null when absent or nothing numeric parses. */
export const parseDoneSpend = (
	raw: string | null | undefined,
): DoneSpend | null => {
	if (!raw) return null;
	let fresh = 0;
	let cached = 0;
	let out = 0;
	let model = "";
	for (const pair of raw.split(",")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const k = pair.slice(0, eq).trim().toLowerCase();
		const v = pair.slice(eq + 1).trim();
		if (k === "model") {
			model = v.slice(0, 24);
			continue;
		}
		const n = Number(v);
		if (!Number.isInteger(n) || n < 0) continue;
		if (k === "fresh" || k === "input" || k === "prompt") fresh += n;
		else if (
			k === "cache" ||
			k === "cached" ||
			k === "cache_read" ||
			k === "cache_in"
		)
			cached += n;
		else if (k === "out" || k === "output") out += n;
	}
	if (fresh + cached + out <= 0) return null;
	return { fresh, cached, out, model };
};

/** The work.done payload fragment: {} when no spend was reported, so the
 *  emit spread stays unconditional (lane-effort.ts pattern). */
export const doneSpendStamp = (
	spend: DoneSpend | null,
): Record<string, unknown> =>
	spend
		? {
				spendFresh: spend.fresh,
				spendCached: spend.cached,
				spendOut: spend.out,
				spendModel: spend.model || undefined,
			}
		: {};

/** Replay the stamp out of a work.done payload (workTiming's effort walk).
 *  Any zero/negative/garbage field degrades to 0 — partial stamps render
 *  what they honestly carry. */
export const spendFromDonePayload = (p: {
	spendFresh?: unknown;
	spendCached?: unknown;
	spendOut?: unknown;
	spendModel?: unknown;
}): DoneSpend | null => {
	const n = (x: unknown): number =>
		typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
	const fresh = n(p.spendFresh);
	const cached = n(p.spendCached);
	const out = n(p.spendOut);
	if (fresh + cached + out <= 0) return null;
	return {
		fresh,
		cached,
		out,
		model: typeof p.spendModel === "string" ? p.spendModel.slice(0, 24) : "",
	};
};
