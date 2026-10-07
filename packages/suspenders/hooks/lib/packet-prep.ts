// hooks/lib/packet-prep.ts — W238 offline task-agnostic packet prep: the
// BUILD-time compression pass for packet prose. Architecture/operational
// text is compressed once when a packet is prepared (dispatch briefs,
// knowledge docs packets — W239's router decides HOW much packet rides; this
// decides how DENSE it is), never per-request, never via a model call: the
// blam canonical engine's `packet` tier does the work — deterministic,
// byte-stable (law L6), offline.
//
// W112 teeth: injection value rides file-level pointers, so the pass proves
// pointer integrity before serving — every pointer-shaped token in the
// input must survive the output verbatim. Any loss degrades honestly to the
// uncompressed input: a packet that cannot prove pointer integrity is not
// served.
import type { CondenseResult } from "@klh/blam/src/condense/engine.ts";
import { condenseTier } from "@klh/blam/src/condense/tiers.ts";

// pointer-shaped tokens, two forms (no escapes — teeth over-check is safe,
// the pass only ever falls back to MORE text):
// - slash paths: `packages/suspenders/hooks`, `a/b.ts` (≥1 slash)
// - extension docs with no slash: `AGENTS.md`, `stack.yaml` (ext whitelist)
// Lookalikes (URL remainders, "v1.2.md") may over-match — harmless here.
const POINTER_RE =
	/[\w-]+(?:\/[\w@./~-]+)+|[\w@~-][\w@./~-]*\.(?:md|mdx|ts|tsx|js|mjs|json|toml|yaml|yml)/g;

/** Order-stable, deduped pointer-shaped tokens in `text`. */
export function extractPointers(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(POINTER_RE)) {
		const tok = m[0];
		if (!out.includes(tok)) out.push(tok);
	}
	return out;
}

/** W112 teeth: input pointers missing from the output. */
export function pointerLoss(input: string, output: string): string[] {
	return extractPointers(input).filter((p) => !output.includes(p));
}

export interface PacketPrepResult {
	/** compressed packet text — or the input verbatim on degradation */
	text: string;
	inBytes: number;
	outBytes: number;
	savedBytes: number;
	/** outBytes / inBytes — 1 when nothing was saved or degraded */
	ratio: number;
	/** ordered rules-fired audit list (engine law L5) */
	rules: string[];
	/** pointer-shaped tokens detected in the input */
	pointers: string[];
	/** input pointers the tier dropped (empty when not degraded) */
	lostPointers: string[];
	/** true ⇒ text is the UNCOMPRESSED input (pointer loss refused) */
	degraded: boolean;
}

// pure finalize, split from prepPacket so tests can drive the degraded
// branch without crafting engine-breaking input
export function finalizePacket(
	input: string,
	r: CondenseResult,
): PacketPrepResult {
	const inBytes = Buffer.byteLength(input, "utf8");
	const pointers = extractPointers(input);
	const lost = pointerLoss(input, r.text);
	const degraded = lost.length > 0;
	const text = degraded ? input : r.text;
	const outBytes = Buffer.byteLength(text, "utf8");
	return {
		text,
		inBytes,
		outBytes,
		savedBytes: inBytes - outBytes,
		ratio: inBytes === 0 ? 1 : outBytes / inBytes,
		rules: r.rules,
		pointers,
		lostPointers: lost,
		degraded,
	};
}

/** The build-time pass: compress `input` via the packet tier, prove pointer
 *  integrity, degrade honestly on any loss. */
export function prepPacket(input: string): PacketPrepResult {
	return finalizePacket(input, condenseTier("packet", input));
}
