// hooks/lib/brief-recall.ts — W1225 lane-brief recall injection: the one
// pre-flight knowledge line every dispatch brief carries, plus the
// error-message→known-procedure match for failures (Amendment D item 5).
// Pointer-grade: real commands only — the trust/precedence doctrine lives in
// the fleet-knowledge rule file and AGENTS.md; the brief names the read faces
// (`coord knowledge` = the read_knowledge CLI face, `fact list --prefix
// lesson.` = the lesson namespace) and derives the query from the mission's
// own terms (same derivation the W254 file map uses).
import { missionTerms } from "./brief-intel.ts";

/** Top mission terms as the recall query — capped so the rendered command
 *  stays one line; missionTerms' char class cannot emit quotes/$, so the
 *  double-quoted shell form stays injection-safe. */
export const recallQuery = (missionText: string, max = 5): string =>
	missionTerms(missionText).slice(0, max).join(" ");

/** The recall block: [] when the mission has no searchable terms — pointer
 *  discipline, never pad the brief with a header without content. */
export const briefRecallLines = (o: {
	missionText: string;
	bin: string;
}): string[] => {
	const q = recallQuery(o.missionText);
	if (!q) return [];
	return [
		`RECALL (pre-flight): before planning, query fleet knowledge for this mission's package — read_knowledge MCP when available; otherwise:`,
		`  bun ${o.bin}/coord.ts knowledge "${q}"  ·  bun ${o.bin}/coord.ts fact list --prefix lesson.`,
		`FAILURE RECALL: on a command failure, before ANY retry, match the error text against known procedures — bun ${o.bin}/coord.ts knowledge "<the error message>" — a kb# hit is the known procedure; verified hits are permission-to-act, the brief's objective still wins.`,
	];
};
