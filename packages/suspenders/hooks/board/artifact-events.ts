// hooks/board/artifact-events.ts — the W1184 artifact scan (work.done/
// review/landed events bound to a commit) as ONE shared reader: the
// execution-projection snapshot and the W1188 attempt-timeline view both
// derive commit milestones from it. Unbound or legacy prose events never
// become artifact evidence (fail-soft per event).
import type { GovernorStore } from "../lib/govdb.ts";
import type { ArtifactEvidence } from "../lib/work-execution.ts";

type Event = {
	ts: number;
	kind: string;
	project: string | null;
	work: string | null;
	payload: string | null;
};

export function artifactEvidence(db: GovernorStore): ArtifactEvidence[] {
	const artifacts: ArtifactEvidence[] = [];
	const rows = db
		.query(
			"SELECT ts, kind, project, work, payload FROM events WHERE kind IN ('work.done','work.review','work.landed') ORDER BY id DESC LIMIT 5000",
		)
		.all() as Event[];
	for (const event of rows) {
		try {
			const payload = JSON.parse(event.payload ?? "{}");
			const receipt =
				event.kind === "work.review"
					? JSON.parse(payload.receipt ?? "null")
					: null;
			const commit = receipt?.commit ?? payload.commit ?? payload.sha;
			const project = event.project ?? payload.project;
			const item = event.work ?? payload.work;
			if (
				typeof commit !== "string" ||
				typeof project !== "string" ||
				typeof item !== "string"
			)
				continue;
			if (
				event.kind === "work.review" &&
				!["PASS", "FAIL", "ERROR"].includes(receipt?.verdict)
			)
				continue;
			artifacts.push({
				project,
				item,
				commit,
				ts: event.ts,
				stage:
					event.kind === "work.landed"
						? "landed"
						: event.kind === "work.done"
							? "completed"
							: receipt.verdict === "PASS"
								? "reviewed"
								: "review-blocked",
			});
		} catch {
			/* Unbound/legacy prose cannot become artifact evidence. */
		}
	}
	return artifacts;
}
