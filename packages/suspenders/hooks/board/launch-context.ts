// hooks/board/launch-context.ts — W1240: the launch-context read model.
// What a lane was literally told before work began: the composed brief the
// dispatch shim already persists per lane at launch — `.fleet/brief-<sid>.md`
// in the project's primary checkout (scripts/dispatch-next.ts writes the same
// bytes it feeds the lane; the worktree copy `.klh-brief.md` is derived). The
// board serves those bytes VERBATIM — never reconstructed, never summarized;
// the raw text is the point. Items that never rode dispatch-next (manual
// takes, queued rows, pre-brief lanes) fall back to their own raw fields,
// labeled; items with neither get an honest "none" so the UI can say so.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalProjectRoot } from "../lib/lane-registry.ts";

/** What a lane was told at launch, plus its provenance. */
export interface LaunchContext {
	/** brief = the verbatim dispatch brief; item = labeled raw item fields; none = nothing stored. */
	source: "brief" | "item" | "none";
	/** the lane sid the brief is keyed to (the item's owner_sid) */
	sid: string | null;
	/** the raw text — full, uncapped */
	text: string;
}

/** Fields the item fallback speaks for (the WorkItemRow slice + its deps). */
export interface LaunchContextItem {
	project: string;
	owner_sid: string | null;
	description: string | null;
	alloc_reason?: string | null;
	why_parallel: string | null;
}

/** The dispatch brief record for one lane sid (never a URL-derived path). */
export function briefFileFor(project: string, sid: string): string {
	return join(canonicalProjectRoot(project), ".fleet", `brief-${sid}.md`);
}

const labeled = (name: string, value: string | null | undefined): string =>
	value?.trim() ? `[${name}] ${value}` : "";

export function launchContextForItem(
	item: LaunchContextItem,
	deps: readonly string[],
): LaunchContext {
	const sid = item.owner_sid;
	if (sid) {
		const brief = briefFileFor(item.project, sid);
		if (existsSync(brief)) {
			return { source: "brief", sid, text: readFileSync(brief, "utf8") };
		}
	}
	// No stored brief: the item's own raw fields, labeled, verbatim.
	const parts = [
		labeled("description", item.description),
		labeled("alloc_reason", item.alloc_reason),
		labeled("why_parallel", item.why_parallel),
		deps.length ? `[depends] ${deps.join(", ")}` : "",
	].filter(Boolean);
	if (!parts.length)
		return { source: "none", sid: item.owner_sid ?? null, text: "" };
	return {
		source: "item",
		sid: item.owner_sid ?? null,
		text: parts.join("\n"),
	};
}
