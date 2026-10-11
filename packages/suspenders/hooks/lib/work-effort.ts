// hooks/lib/work-effort.ts — W248 per-item effort budget: simple = work
// solo, 3-10 tool calls; complex = fan out. One vocabulary, three consumers:
// work.ts validates --effort at add + renders the field in show; the brief
// composer composes the EFFORT BUDGET line into the lane brief; the budget
// TEXT lives here too (1500-line law: bin/work.ts sits near the cap).
export const EFFORTS = ["simple", "complex"] as const;
export type Effort = (typeof EFFORTS)[number];

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The brief's budget line per effort class; null = unset item (no budget —
 *  legacy briefs stay byte-identical). */
export const effortBudgetLine = (
	effort: string | null | undefined,
): string | null => {
	if (effort === "simple")
		return "EFFORT BUDGET: simple — one lane, work solo; target 3-10 tool calls; no fan-out — close the item yourself.";
	if (effort === "complex")
		return "EFFORT BUDGET: complex — fan out: on 2+ genuinely independent scopes, work split and keep one child; otherwise full depth solo.";
	return null;
};

/** Parse the effort from `work show` text render (ANSI-stripped): the field
 *  line is exactly two spaces + `effort: <value>` (work.ts show field list).
 *  Unknown values read as unset — the brief carries no budget line for them. */
export const effortFromShow = (showOut: string): string | null => {
	const m = /^ {2}effort: (.+)$/m.exec(showOut.replace(ANSI, ""));
	const v = m?.[1]?.trim();
	return v && (EFFORTS as readonly string[]).includes(v) ? v : null;
};
