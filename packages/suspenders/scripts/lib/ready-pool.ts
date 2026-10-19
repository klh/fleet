// ready-pool.ts — READY-pool parsing/gating helpers extracted from
// dispatch-next.ts (W636 decomposition, the 1500-line law): the pool row
// syntax (parseReady), the owner-gate heuristic (isOwnerGated) and the W619
// capability pre-filter (capabilityGate) are pure decision functions over
// `work ready` output — no IO, fully unit-testable on their own.
export const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** parse `work ready` rows (renderRow format, ANSI-stripped): glyph, id,
 *  truncated title, and the `⟨needs …⟩` capability suffix (W619 — the
 *  dispatch-side capability pre-filter reads it). The title is for gating/log
 *  lines only — the brief must carry the FULL spec from `work show` (gaps W279
 *  phantom-lane lesson). W494: the renderer pads the id field (width 7) — ids
 *  ≥7 chars emit NO separator space, so the id/title gap is zero-or-more and
 *  the title may be empty. The [\d.]+ class stops the id at the first non-id
 *  char. */
export const parseReady = (
	stdout: string,
): { id: string; title: string; requires: string[] }[] =>
	stdout
		.replace(ANSI, "")
		.split("\n")
		.map((l) => /^\s*·\s+(W[\d.]+)\s*(.*)$/.exec(l.trimEnd()))
		.map((m) => {
			if (!m) return null;
			const needs = /⟨needs ([^⟩]*)⟩/.exec(m[2]);
			return {
				id: m[1],
				title: m[2].trim(),
				requires: needs
					? needs[1]
							.split(",")
							.map((c) => c.trim())
							.filter(Boolean)
					: [],
			};
		})
		.filter((x): x is { id: string; title: string; requires: string[] } => !!x);

/** Only an explicit owner gate in the title blocks automatic dispatch.
 * Event names such as NEED_DECISION and paused are ordinary feature work. */
export const isOwnerGated = (title: string): boolean =>
	/^\s*OWNER[- ]GATED\s*:/i.test(title);

/** W619 capability gate: split the fresh READY pool into dispatchable rows
 *  and capability-mismatched skips. Pure — capsOf injects the sessions read
 *  (the take check's exact mirror: a never-dispatched sid has no row, so its
 *  caps are empty and any requires-work starves). skips are the SKIP notes
 *  main() prints; starved aggregates capability → wanting items. */
export const capabilityGate = (
	rows: { id: string; requires: string[] }[],
	capsOf: (sid: string) => string[],
	laneSidOf: (id: string) => string,
): {
	dispatchable: { id: string; requires: string[] }[];
	starved: Map<string, string[]>;
	skips: string[];
} => {
	const starved = new Map<string, string[]>();
	const dispatchable: { id: string; requires: string[] }[] = [];
	const skips: string[] = [];
	for (const r of rows) {
		const sid = laneSidOf(r.id);
		const missing = r.requires.filter((c) => !capsOf(sid).includes(c));
		if (!missing.length) {
			dispatchable.push(r);
			continue;
		}
		skips.push(
			`SKIP ${r.id} — capability-mismatched: requires [${r.requires.join(",")}] missing [${missing.join(",")}] on lane ${sid.slice(0, 8)} — dispatch to a capable agent`,
		);
		for (const c of missing) starved.set(c, [...(starved.get(c) ?? []), r.id]);
	}
	return { dispatchable, starved, skips };
};
