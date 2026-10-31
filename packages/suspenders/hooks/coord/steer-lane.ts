// steer-lane.ts — W2328: the steer gate+emit sequence as a lib face so the
// dataplane's Lanes/Steer rides the VERB'S OWN enforcement (design law: the
// dataplane adds no policy of its own) instead of re-deriving the gates.
// steer.ts keeps the CLI rendering; this module owns the ordered gate
// sequence both faces share.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scanLine, scrubRules } from "../lib/gates/scrub.ts";
import type { LaneRef } from "../lib/lanes/lane-liveness.ts";
import { laneVerdict } from "../lib/lanes/lane-liveness.ts";
import {
	canonicalProjectRoot,
	loadLaneRegistry,
} from "../lib/lanes/lane-registry.ts";
import {
	ackFor,
	logReadOf,
	STEER_PAUSE_FILE,
	steerWindowMs,
} from "../lib/steer-decision.ts";
import { emitSteer, stampSteerFact, steerRateLimited } from "./steer.ts";

export type SteerOutcome = "accepted" | "pending" | "failed";

export interface SteerLaneResult {
	outcome: SteerOutcome;
	/** failed_precondition detail for the dataplane's problem+json face. */
	detail: string;
	eventId: number | null;
}

/** `coord steer`'s full gate sequence as a callable: pause kill switch →
 *  scrub ruleset → liveness → rate limit → emit + rate-stamp. A refused
 *  steer never queues an event nor consumes the rate budget. The consult
 *  interrupt leg (steerForConsult) keeps its own narrower gate set — that
 *  divergence is the verb's documented policy, not a drift. */
export function steerLane(
	sid: string,
	text: string,
	source: string,
	root: string = canonicalProjectRoot(process.cwd()),
): SteerLaneResult {
	if (existsSync(join(root, ".fleet", STEER_PAUSE_FILE)))
		return {
			outcome: "failed",
			detail: `steering paused — .fleet/${STEER_PAUSE_FILE} kill switch is set`,
			eventId: null,
		};
	const hits = scanLine(text, scrubRules());
	if (hits.length)
		return {
			outcome: "failed",
			detail: `steer refused — input trips the scrub ruleset (${hits
				.map((h) => `${h.rule}: ${h.match}`)
				.join("; ")}) — never steer with secrets`,
			eventId: null,
		};
	const row = loadLaneRegistry<SteerLaneRow>(root).find((l) => l.sid === sid);
	const verdict = row ? laneVerdict(row) : "unknown";
	if (verdict !== "alive")
		return {
			outcome: "failed",
			detail: `lane not provably live (probe ${verdict}); redo is the honest path`,
			eventId: null,
		};
	if (steerRateLimited(sid))
		return {
			outcome: "failed",
			detail: `steer rate-limited — one steer per sid per steer.min_interval_s (${Math.round(steerWindowMs() / 1000)}s)`,
			eventId: null,
		};
	const { phase } = logReadOf(root, sid);
	const eventId = emitSteer(sid, text, source);
	stampSteerFact(sid);
	const ack = ackFor("alive", phase);
	return {
		outcome: ack,
		detail: `queued; log phase ${phase}`,
		eventId,
	};
}

type SteerLaneRow = LaneRef & { attempt?: number; agent?: string };
