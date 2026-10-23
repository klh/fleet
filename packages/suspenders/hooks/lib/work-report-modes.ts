// hooks/lib/work-report-modes.ts — W1131 §10: the tree/delta/statusline
// MODES. All three render FROM the §1 versioned contract (work-report.ts) —
// the modes never re-derive state, so chat, statusline, and CLI cannot
// disagree with the table.

import {
	agentClock,
	type ReportContract,
	type ReportItem,
} from "./work-report.ts";
import {
	type RenderOpts,
	renderTty,
	SECTION_LABEL,
	truncateTask,
} from "./work-report-render.ts";
import { reportBoardBase } from "./work-report-live.ts";

/** --tree (§10): the chat list — markdown links, no ANSI (chat renders
 *  markdown; escapes would leak). Header: lanes here + status counts +
 *  local HH:MM; rows carry glyph + word, age, model@hub, a ⎿ activity line;
 *  footer sums the other repos + the board link. */
export const renderTree = (
	c: ReportContract,
	opts: { boardUrl?: string } = {},
): string => {
	const hhmm = new Date(c.now_ms).toTimeString().slice(0, 5);
	const here = c.items.filter((i) => i.section === "working");
	const count = (sec: string): number =>
		c.items.filter((i) => i.section === sec).length;
	const counts = [
		count("needs_you") ? `${count("needs_you")} need you` : "",
		`${here.length} riding`,
		`${count("waiting")} queued`,
		`${count("done")} done`,
	]
		.filter(Boolean)
		.join(" · ");
	const rows = c.items.map((i) => {
		const bits = [`age ${i.age_ms == null ? "—" : agentClock(i.age_ms)}`];
		if (i.model) bits.push(i.hub ? `${i.model}@${i.hub}` : i.model);
		const act =
			i.last_activity_ms_ago == null
				? ""
				: ` ⎿ ${agentClock(i.last_activity_ms_ago)} ago`;
		return `- [${i.id}](${i.links.task}) ${i.glyph} ${i.status} · ${bits.join(" · ")} — ${truncateTask(i.title)}${act}`;
	});
	const rest = c.footer.lanes_other_projects;
	const board = opts.boardUrl ?? baseOf(c);
	const footer = [rest ? `+${rest} in other repos` : "", `[board](${board})`]
		.filter(Boolean)
		.join(" · ");
	return [
		`⏺ fleet · ${here.length} lanes here · ${counts} · ${hhmm}`,
		...rows,
		footer,
	].join("\n");
};

/** The board origin embedded in the contract's own deep-links (§9) — the
 *  footer board link is the same origin, never re-configured. */
const baseOf = (c: ReportContract): string =>
	c.items[0]?.links.task.split("/#")[0] ?? reportBoardBase();

/** §10 --delta: ONE line of transitions since the last emit; empty string
 *  when nothing changed. Transitions = section moves (§4), hub moves (§8),
 *  and items appearing or disappearing from scope. */
export interface DeltaTransition {
	id: string;
	from: string;
	to: string;
	hub: string | null;
}

/** The persisted shape: exactly what a transition needs (small, stable). */
export interface DeltaState {
	schema_version: 1;
	items: Array<Pick<ReportItem, "id" | "section" | "hub">>;
}

export const deltaTransitions = (
	prev: DeltaState | null,
	cur: { items: ReportItem[] },
): DeltaTransition[] => {
	const p = new Map((prev?.items ?? []).map((i) => [i.id, i]));
	const out: DeltaTransition[] = [];
	for (const i of cur.items) {
		const was = p.get(i.id);
		if (!was) {
			// items absent from a null baseline are not "new" — first emit is quiet
			if (prev) out.push({ id: i.id, from: "new", to: i.section, hub: i.hub });
			continue;
		}
		if (was.section !== i.section)
			out.push({ id: i.id, from: was.section, to: i.section, hub: i.hub });
		else if (was.hub !== i.hub)
			out.push({ id: i.id, from: was.section, to: was.section, hub: i.hub });
	}
	if (prev) {
		const ids = new Set(cur.items.map((i) => i.id));
		for (const [id, was] of p)
			if (!ids.has(id))
				out.push({ id, from: was.section, to: "gone", hub: was.hub });
	}
	return out;
};

/** The one --delta line; caps at 6 transitions + a more-count. */
export const renderDeltaLine = (ts: DeltaTransition[]): string => {
	if (!ts.length) return "";
	const w = (s: string): string => SECTION_LABEL[s] ?? s;
	const line = ts
		.slice(0, 6)
		.map((t) => {
			const hub = t.hub ? `@${t.hub}` : "";
			if (t.from === "new") return `+${t.id} ${w(t.to)}${hub}`;
			if (t.to === "gone") return `−${t.id}`;
			return `${t.id} ${w(t.from)}→${w(t.to)}${hub}`;
		})
		.join(" · ");
	return ts.length > 6 ? `${line} · +${ts.length - 6} more` : line;
};

/** §10 delta state: one file per project scope under the governor cache —
 *  the previous emit's items (id/section/hub only). */
export const deltaStatePath = (project: string): string => {
	const home = process.env.SUSPENDERS_REPORT_STATE_DIR ?? "";
	const dir = home || `${process.env.HOME ?? "/tmp"}/.cache/claude-governor`;
	let h = 0;
	for (const ch of project || "all") h = (h * 31 + ch.charCodeAt(0)) | 0;
	return `${dir}/report-delta-${(h >>> 0).toString(36)}.json`;
};

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const readDeltaState = (path: string): DeltaState | null => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			(parsed as DeltaState).schema_version === 1 &&
			Array.isArray((parsed as DeltaState).items)
		)
			return parsed as DeltaState;
		return null;
	} catch {
		return null;
	}
};

export const writeDeltaState = (path: string, c: ReportContract): void => {
	try {
		mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
		const state: DeltaState = {
			schema_version: 1,
			items: c.items.map((i) => ({ id: i.id, section: i.section, hub: i.hub })),
		};
		writeFileSync(path, JSON.stringify(state));
	} catch {
		// delta state is best-effort — never blocks a report
	}
};

/** --statusline (§10): ONE line, ANSI allowed. Needs-you first (§4), then
 *  the live shape, hubs (§8), and the stall grace. */
export const renderStatusline = (c: ReportContract): string => {
	const count = (sec: string): number =>
		c.items.filter((i) => i.section === sec).length;
	const hubs = Object.entries(c.totals.lanes_per_hub)
		.map(([h, n]) => `${h}×${n}`)
		.join(" ");
	return [
		c.needs_you.count ? `⚠ ${c.needs_you.count}` : "",
		`◐ ${count("working")}`,
		`· ${count("waiting")}`,
		`✓ ${count("done")}`,
		hubs,
		`stall>${agentClock(c.stall_ms)}`,
	]
		.filter(Boolean)
		.join(" · ");
};

/** --watch view pick (§10): wide table at >=100 columns, tree under it.
 *  The WS-driven loop itself lives in the verb — this is the render pick. */
export const watchViewOf = (c: ReportContract, width: number): string =>
	width >= 100 ? renderTtyWide(c) : renderTree(c);

const renderTtyWide = (c: ReportContract): string =>
	renderTty(c, { format: "tty", wide: true } satisfies RenderOpts);
