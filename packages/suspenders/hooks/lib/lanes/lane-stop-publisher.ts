import { createHash } from "node:crypto";
import { emitStoredEvent } from "../../coord/event-publish.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import {
	completionBlockCode,
	completionBlockNote,
	laneStopDecision,
	laneStopTarget,
} from "./lane-stop-decision.ts";

/** Only known claim/context refusals become operational incidents. */
export function publishCompletionBlock(
	db: GovernorStore,
	claim: {
		project: string;
		item: string;
		sid: string;
		revision: string | null;
	},
	error: unknown,
): number | null {
	const code = completionBlockCode(error);
	if (!code) return null;
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				claim.project,
				claim.item,
				claim.sid,
				claim.revision,
				code,
			]),
		)
		.digest("hex");
	return db.transaction(() => {
		const previous = db
			.query(
				"SELECT id FROM events WHERE kind='NEED_DECISION' AND json_valid(payload) AND json_extract(payload,'$.incident_key')=? LIMIT 1",
			)
			.get(key) as { id: number } | null;
		if (previous) return previous.id;
		const event = laneStopDecision(
			claim.project,
			claim.item,
			claim.sid,
			completionBlockNote(claim.item, code),
			laneStopTarget(db, claim.project, claim.sid),
		);
		return emitStoredEvent(db, claim.project, {
			...event,
			extra: { ...event.extra, code, incident_key: key },
		});
	})();
}
