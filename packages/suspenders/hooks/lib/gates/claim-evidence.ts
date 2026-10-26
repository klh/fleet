// hooks/lib/gates/claim-evidence.ts — W1731: the format-agnostic half of the
// W833 claim-check (design.client-adapter-dispatch). One normalized event
// shape — claims from assistant prose, runs from the output of test
// invocations the session's own assistant initiated — fed by per-client
// evidence readers that live on the executor registry
// (ExecutorAdapter.evidence). A new transcript format is one reader in its
// adapter's file, never a branch here or in the verifier. Detection
// vocabulary is assembled from split string parts so the W511 scan never
// flags this file's own source.

export const assemble = (...parts: string[]): string => parts.join("");

// claim vocabulary — assistant prose only; briefs and user turns never claim
const CLAIM_RES: RegExp[] = [
	/\b(?:all\s+)?tests?\s+(?:pass|passed|passing|green)\b/i,
	/\btests?\s+are\s+(?:passing|green)\b/i,
	/\bsuite\s+(?:is\s+)?(?:green|passing)\b/i,
];
const NEG_PRE =
	/\b(?:no|not|never|without|cannot|didn't|doesn't|won't|can't)\b[^.]*$/i;
const RUN_PASS = /(\d+)\s+pass(?:ed)?\b/i;
const RUN_FAIL = /(\d+)\s+fail(?:ed|ure)?\b/i;

/** a test-pass claim in lane prose (negations in the preceding window void it). */
export const isClaim = (text: string): boolean =>
	CLAIM_RES.some((re) => {
		const m = re.exec(text);
		if (!m) return false;
		const at = m.index ?? 0;
		return !NEG_PRE.test(text.slice(Math.max(0, at - 40), at));
	});

/** pass/fail counts from a test-summary tool output (bun/jest/vitest sums). */
export const runCounts = (
	text: string,
): { pass: number; fail: number } | null => {
	const p = RUN_PASS.exec(text);
	const f = RUN_FAIL.exec(text);
	if (!p && !f) return null;
	return { pass: p ? Number(p[1]) : 0, fail: f ? Number(f[1]) : 0 };
};

export const isPassingRun = (text: string): boolean => {
	const c = runCounts(text);
	return c !== null && c.pass > 0 && c.fail === 0;
};

export interface ClaimEvent {
	ts: number;
	text: string;
}
export interface TranscriptEvents {
	claims: ClaimEvent[];
	runs: ClaimEvent[];
}

/** What a reader reports per transcript line: assistant prose (claim
 *  candidates) and the output of an own-initiated test invocation (run
 *  candidates). Vocabulary filtering and timestamp policy stay here. */
export interface EvidenceSink {
	prose(ts: number, text: string): void;
	output(ts: number, text: string): void;
}
/** One parsed transcript line and its timestamp (0 = untimestamped). */
export type EvidenceReader = (
	line: Record<string, unknown>,
	ts: number,
	sink: EvidenceSink,
) => void;
/** A fresh reader per transcript — pairing state lives in its closure. */
export type EvidenceNormalizer = () => EvidenceReader;

/** The text of a `{ text: string }` content part; "" for anything else. */
export const partText = (part: unknown): string => {
	if (!part || typeof part !== "object") return "";
	const text = (part as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
};

/** One pass over transcript JSONL. Every registered reader contributes
 *  prose, so a claim stays visible whatever client the lane resolves to;
 *  only the resolved client's reader contributes run output, so a wrong or
 *  absent client narrows the evidence to nothing and a claim fails closed.
 *  Untimestamped events drop. */
export function normalizeTranscript(
	text: string,
	readers: readonly EvidenceNormalizer[],
	evidence: EvidenceNormalizer | undefined,
): TranscriptEvents {
	const out: TranscriptEvents = { claims: [], runs: [] };
	const prose = (ts: number, t: string): void => {
		if (ts > 0 && isClaim(t)) out.claims.push({ ts, text: t });
	};
	const output = (ts: number, t: string): void => {
		if (ts > 0 && runCounts(t)) out.runs.push({ ts, text: t });
	};
	const proseOnly: EvidenceSink = { prose, output: () => {} };
	const all =
		evidence && !readers.includes(evidence) ? [...readers, evidence] : readers;
	const active = all.map((normalizer) => ({
		read: normalizer(),
		sink: normalizer === evidence ? { prose, output } : proseOnly,
	}));
	for (const raw of text.split("\n")) {
		if (raw.length < 2) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const line = parsed as Record<string, unknown>;
		const ts = Date.parse(String(line.timestamp ?? "")) || 0;
		for (const { read, sink } of active) read(line, ts, sink);
	}
	return out;
}
