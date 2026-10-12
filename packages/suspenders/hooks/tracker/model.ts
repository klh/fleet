// hooks/tracker/model.ts — W575: the tracker's shared cell vocabulary and
// pure transition mapping. No I/O, no imports — the smallest thing every
// tracker module and test can agree on.
export type CellState =
	| "queued"
	| "claimed"
	| "running"
	| "decision"
	| "complete"
	| "failed"
	| "stalled"
	| "unknown";

// One glyph per state — the non-colour channel: shapes are unique so a
// colour-blind or monochrome terminal still reads every cell. Colour is
// additive (render.ts), never the only signal.
export const SYMBOLS: Record<CellState, string> = {
	queued: "·",
	claimed: "◇",
	running: "▶",
	decision: "?",
	complete: "✓",
	failed: "✗",
	stalled: "!",
	unknown: "~",
};

// event kinds → CellState. The mission's "testing" has no canonical signal
// on the shared surfaces (no event kind, no work_items.state) — the tracker
// invents no second-ledger signal for it; if one lands, KINDS maps it.
export const KINDS: Record<string, CellState> = {
	"work.added": "queued",
	"work.ready": "queued",
	"work.claimed": "claimed",
	"work.done": "complete",
	"work.failed": "failed",
	"work.released": "queued",
	"work.recovery-reset": "queued",
	"work.recovery-reserved": "claimed",
	"work.shattered": "queued",
	"work.tree": "queued",
};

// NEED_DECISION / consult rows ride the decision channel; they are lane
// transitions (who waits on whom), not item transitions.
export const DECISION_KINDS = [
	"NEED_DECISION",
	"consult",
	"consult.answer",
] as const;

// Work-item state (+ the lane's liveness verdict) → current cell state.
// This is the bottom "now" row per lane column.
export function stateToCellState(
	state: string,
	lane: { live: boolean; stalled: boolean; unknown: boolean },
): CellState {
	switch (state) {
		case "READY":
			return "queued";
		case "RUNNING":
			return lane.unknown ? "unknown" : lane.live ? "running" : "claimed";
		// a CLAIMED item on a stalled lane is the mission's stalled cell
		case "CLAIMED":
			return lane.unknown
				? "unknown"
				: lane.stalled
					? "stalled"
					: lane.live
						? "running"
						: "claimed";
		case "FAILED":
			return "failed";
		case "DONE":
			return "complete";
		default:
			return "unknown";
	}
}
