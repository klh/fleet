// dispatch-admission.ts — W576.1.1 decomposition of dispatch-next.ts
// (1500-line law): admission-side reads shared by the dispatch entry and
// its consumers — capsule stdout parsing and the dry-run executor-cv
// snapshot. The CLI-spawning wrappers (capsuleGet/itemCapsuleGet) stay in
// the entry: they bind argv-derived BIN/sh.
import { hostname } from "node:os";
import { cvMap } from "../../hooks/lib/executor-cv.ts";
import { openStore } from "../../hooks/lib/govdb.ts";
import { ANSI } from "./ready-pool.ts";

/** `coord capsule get --as <sid>` output → parsed capsule, or null when the
 *  lane has none. (Bare `capsule get <sid>` misparses the sid as "get" —
 *  always pass --as.) */
export const parseCapsuleGet = (
	stdout: string,
): Record<string, string> | null => {
	const line = stdout.replace(ANSI, "").trim();
	if (!line || line.includes("(no capsule)")) return null;
	try {
		const c = JSON.parse(line) as Record<string, string>;
		return typeof c === "object" && c !== null ? c : null;
	} catch {
		return null;
	}
};

// W620: dry-run cv snapshot — facts read only, no write; the dry brief shows
// the same trust-reordered default ladder the spawn path would pick.
export const cvSnapshot = (): Map<string, number> => {
	const s = openStore();
	try {
		return cvMap(s, hostname());
	} finally {
		s.close();
	}
};
