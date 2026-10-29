import type { Database } from "./shared.ts";
import { dim } from "./shared.ts";
import { reportRows, reportTableLinkOpts } from "../lib/work/work-report.ts";
import { buildReportTable } from "../lib/work/work-report-render.ts";
import { buildFleetTable, fleetGlyph } from "./fleet-table.ts";

// hooks/coord/fleet-faces.ts — the `coord fleet` render faces, extracted from
// fleet.ts in W2214: the merge of W1242 (the ONE W892 supervisor table via
// hooks/lib/work/, the same source `work report` rides, plus --project graph
// selection) with main's W1258 face (the fixed-width lane table, --njson and
// --json machine faces). One module per responsibility — fleet.ts holds the
// data collection; this module owns rendering. Glyph honesty (W652.1/W378)
// rides fleet-table.ts verbatim.

export interface FleetFacesInput {
	rest: string[];
	db: Database;
	project: string;
	head: string | null;
	lanes: string[];
	crows: { sid: string; scope: string; intent: string | null }[];
	work: {
		sid: string;
		project: string;
		id: string;
		title: string;
		state: string;
	}[];
	sessions: Map<string, string>;
	byKey: Map<string, string>;
	sessionNames: Map<string, string>;
	names: Map<string, string>;
	verdictOf: (sid: string) => string;
}

// W522 fleet-watch feed — the same projection, machine-readable: lane
// state facts + session names + claim intents, no ANSI. Undefined state
// facts mean a fresh claim (text path paints ▶ too). W1258: --njson adds
// the same lane entries as NDJSON, one fleet entry per line; the --json
// contract is unchanged.
export const fleetLaneEntry = (
	l: string,
	i: FleetFacesInput,
	v: string,
): Record<string, unknown> => ({
	sid: l,
	name: i.sessionNames.get(l) ?? null,
	intent: i.names.get(l) ?? null,
	state: i.byKey.get(`lane.${l}.state`) ?? i.sessions.get(l) ?? "UNKNOWN",
	sessionState: i.sessions.get(l) ?? null,
	fileClaims: i.crows
		.filter((claim) => claim.sid === l)
		.map(({ scope, intent }) => ({ scope, intent })),
	workItems: i.work
		.filter((item) => item.sid === l)
		.map(({ project, id, title, state }) => ({
			project,
			id,
			title,
			state,
		})),
	verdict: v,
	live: v === "alive",
});

/** The fleet faces in priority order: --njson (NDJSON lanes), --json (the
 *  W522 contract), then the text face — the W1242 supervisor table leads and
 *  the W1258 lane projection (fleet-table.ts, W652.1/W378 honesty glyphs)
 *  stays beneath; --json above stays the machine face. Attribution-absent
 *  columns degrade inside the shared renderer. */
export const renderFleetFaces = (i: FleetFacesInput): void => {
	if (i.rest.includes("--njson")) {
		for (const l of i.lanes)
			console.log(JSON.stringify(fleetLaneEntry(l, i, i.verdictOf(l))));
		return;
	}
	if (i.rest.includes("--json")) {
		console.log(
			JSON.stringify({
				head: i.head?.slice(0, 7) ?? null,
				lanes: i.lanes.map((l) => fleetLaneEntry(l, i, i.verdictOf(l))),
			}),
		);
		return;
	}
	const { rows } = reportRows(i.db as unknown as Database, i.project, {
		now: Date.now(),
	});
	if (i.head) console.log(dim(`HEAD ${i.head.slice(0, 7)}`));
	console.log(buildReportTable(rows, reportTableLinkOpts()));
	if (!i.lanes.length) {
		console.log(dim("(no claimed lanes)"));
		return;
	}
	console.log(
		buildFleetTable(
			i.lanes.map((l) => ({
				lane: i.sessionNames.get(l) ?? i.names.get(l) ?? l.slice(0, 8),
				st: fleetGlyph(i.verdictOf(l), i.byKey.get(`lane.${l}.state`)),
				task: i.names.get(l) ?? "",
				sid: l,
			})),
		),
	);
};
