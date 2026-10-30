// hold-drain.ts — W2318 HoldAndDrain: when the dispatch hold carries
// mode:"drain" (Kueue StopPolicy HoldAndDrain vocabulary), the fleet-loop
// STEERS live lanes toward checkpointing and landing — never kill (a lane's
// in-flight agent context is not checkpointable; the design doc's
// do-not-adopt note on preemption). One pass = one steer per live lane per
// resteer window, deduped in .fleet/hold-drain.json so a drain episode
// reminds rather than spams. The steer rides the ONE directed-event seam
// (the steer interrupt leg → the W303 inbox), so the kill switch, scrub
// ruleset and liveness probe all still gate every steer.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { steerForConsult } from "../../coord/steer.ts";
import { dispatchHoldActive, type HoldMode } from "./dispatch-hold.ts";
import { type LaneRef, laneVerdict } from "./lane-liveness.ts";
import { loadLaneRegistry } from "./lane-registry.ts";

/** Drain reminder cadence: one steer per lane per resteer window. */
export const HOLD_DRAIN_RESTEER_MS = 30 * 60_000;

/** The steer seam: same ack vocabulary as coord steer. */
export type DrainSteer = (
	sid: string,
	text: string,
	source: string,
) => ReturnType<typeof steerForConsult>;

/** Steered-lane state: one episode = one hold (keyed by its set_at). */
export interface DrainState {
	episode: string;
	steered: Record<string, number>;
}

const statePath = (fleetDir: string): string =>
	join(fleetDir, "hold-drain.json");

/** The registry path: only provably-live lanes get steered. */
const aliveLanes = (root: string): LaneRef[] =>
	loadLaneRegistry(root).filter((l) => laneVerdict(l) === "alive");

const readState = (fleetDir: string): DrainState => {
	try {
		const raw: unknown = JSON.parse(readFileSync(statePath(fleetDir), "utf8"));
		if (
			typeof raw === "object" &&
			raw !== null &&
			!Array.isArray(raw) &&
			typeof (raw as DrainState).episode === "string"
		)
			return raw as DrainState;
	} catch {
		// absent/corrupt state = a fresh episode
	}
	return { episode: "", steered: {} };
};

const writeState = (fresh: DrainState, fleetDir: string): void => {
	writeFileSync(statePath(fleetDir), JSON.stringify(fresh));
};

/** The checkpoint prompt: land what you hold, do not start new scopes. */
export const drainPrompt = (by: string): string =>
	`[hold-drain] Dispatch hold (HoldAndDrain) by ${by}: maintenance window — checkpoint and land now: run gates, commit on your branch, bank a capsule (coord capsule set --checkpoint=<head>), work done when green. Do not take new scopes; wrap up.`;

export interface DrainPassResult {
	/** "idle" = no drain-mode hold observed. */
	mode: HoldMode | "idle";
	steered: string[];
	/** lanes already steered inside the resteer window. */
	resting: string[];
	failed: [string, string][];
}

/** ONE drain pass; `steer`/`lanes` injectable so tests record, not emit. */
export const drainPass = (
	root: string,
	fleetDir: string,
	opts: { steer?: DrainSteer; lanes?: LaneRef[] } = {},
	now = Date.now(),
): DrainPassResult =>
	drainBody(
		root,
		fleetDir,
		now,
		dispatchHoldActive(fleetDir, now),
		opts.steer ?? steerForConsult,
		opts.lanes,
	);

const drainBody = (
	root: string,
	fleetDir: string,
	now: number,
	obs: NonNullable<ReturnType<typeof dispatchHoldActive>>,
	steer: DrainSteer,
	lanes?: LaneRef[],
): DrainPassResult => {
	if (!obs || obs.legacy || obs.hold.mode !== "drain")
		return {
			mode: obs?.hold.mode ?? "idle",
			steered: [],
			resting: [],
			failed: [],
		};
	const by = obs.hold.by;

	const episode = obs.hold.set_at;
	const prior = readState(fleetDir);
	const fresh: DrainState =
		prior.episode === episode ? prior : { episode, steered: {} };
	const steered: string[] = [];
	const resting: string[] = [];
	const failed: [string, string][] = [];
	// injected lanes are pre-filtered by the caller — verdict runs on the
	// registry path only (real processes; tests pass explicit sets).
	for (const lane of lanes ?? aliveLanes(root)) {
		const last = fresh.steered[lane.sid];
		if (last !== undefined && now - last < HOLD_DRAIN_RESTEER_MS) {
			resting.push(lane.sid);
			continue;
		}
		const ack = steer(lane.sid, drainPrompt(by), "hold-drain");
		if (ack === "failed") {
			failed.push([lane.sid, ack]);
			continue;
		}
		fresh.steered[lane.sid] = now;
		steered.push(lane.sid);
	}
	if (steered.length > 0 || prior.episode === episode)
		writeState(fresh, fleetDir);
	return { mode: "drain", steered, resting, failed };
};
