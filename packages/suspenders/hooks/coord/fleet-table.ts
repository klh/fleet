// fleet-table.ts — W1258: `coord fleet` text face renders the fleet as the
// fixed-width fleet table (the W892 `work report` style: header row +
// per-column dash separator, programmatic pads via cli-table3, W976
// borderless config). One lane per row — the one-line concat it replaced ran
// the whole fleet together and widened without bound. Columns LANE/ST/TASK/
// SID: LANE = the W293 user-facing name, else claim intent, else short sid;
// ST = the W652.1/W378 verdict+state glyph (only positive evidence paints
// ▶); TASK = claim intent or owned work item; SID = the `[sid=...]`
// recipient field (the session-start addressing surface).
import Table from "cli-table3";
import { REPORT_TABLE_CHARS } from "../lib/work/work-report.ts";
import { amber, cyan, dim, green, red } from "./shared.ts";

/** One table row: the flat cells cmdFleet projects per lane. Raw strings —
 *  the builder owns the caps (LANE truncates with an ellipsis at the house
 *  24, TASK slices at the report's 26, no ellipsis — the W892 convention). */
export interface FleetRow {
	lane: string;
	st: string;
	task: string; // "" renders "-"
	sid: string;
}

/** LANE cap — the coord-fleet label truncation already in the text face. */
export const FLEET_LANE_CAP = 24;

/** TASK cap — the W892 report's TASK_CAP convention (26, no ellipsis). */
export const FLEET_TASK_CAP = 26;

const FLEET_COLUMNS = ["LANE", "ST", "TASK", "SID"];

/** ST glyph: verdict says death/unknown; a live lane's `lane.<sid>.state`
 *  fact picks the pause/blocked glyph; plain alive = ▶ (W652.1/W378
 *  honesty vocabulary, verbatim from the text face it replaces). */
export const fleetGlyph = (
	verdict: string,
	state: string | undefined,
): string =>
	verdict === "dead"
		? red("×")
		: verdict === "unknown"
			? dim("?")
			: state === "PAUSE_REQUESTED"
				? amber("◐")
				: state === "PAUSED"
					? amber("⏸")
					: state === "RESUME_READY"
						? cyan("↻")
						: state === "BLOCKED"
							? red("⚠")
							: green("▶");

const truncLane = (s: string): string =>
	s.length > FLEET_LANE_CAP ? `${s.slice(0, FLEET_LANE_CAP - 1)}…` : s;

/** Visible length: cli-table3 pads ANSI-aware, but the separator dashes are
 *  computed HERE from raw lengths — a painted glyph's SGR escape bytes would
 *  balloon the ST column on a TTY. Strip SGR sequences before measuring
 *  (ESC assembled from charCode — the lint bans control chars in regex). */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const visibleLen = (s: string): number => s.replace(SGR, "").length;

/** The fleet table: LANE/ST/TASK left, SID left — all strings, no numeric
 *  right-align (the report's numeric columns have no fleet counterpart). */
export const buildFleetTable = (rows: FleetRow[]): string => {
	const cells = rows.map((r) => [
		truncLane(r.lane),
		r.st,
		r.task.slice(0, FLEET_TASK_CAP) || "-",
		`[sid=${r.sid}]`,
	]);
	const widths = FLEET_COLUMNS.map((h, c) =>
		Math.max(h.length, ...cells.map((row) => visibleLen(row[c]))),
	);
	const table = new Table({
		chars: REPORT_TABLE_CHARS,
		colAligns: ["left", "left", "left", "left"],
		style: { head: [], border: [], "padding-left": 0, "padding-right": 0 },
	});
	table.push(FLEET_COLUMNS);
	table.push(widths.map((w) => "-".repeat(w)));
	for (const row of cells) table.push(row);
	return table.toString();
};
