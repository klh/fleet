// work-fail.ts — W2333 (Kueue F4): the terminal FAILED write is
// reason-carrying. Kueue's QuotaReservedReason* vocabulary (workload_types.
// go:943) makes every terminal/pending row explain itself; the fleet twin is
// the LaunchFailure kind (rate-limit/upstream/transport/configuration,
// launch-backoff.ts) stamped as a machine-readable column + event field on
// the terminal record — `work retry` policy and the board read the kind,
// never the transcript. Home of the fail verb's handler body (extracted from
// work.ts, the W761 retry-verb precedent).
import type { Database } from "bun:sqlite";
import { classifyLaunchFailure } from "../../../scripts/lib/launch-backoff.ts";
import type { GovernorStore } from "../govdb/govdb.ts";
import { resolveSidOf } from "../govdb/govdb-sessions.ts";
import { reactivationRefusalMessage } from "./work-completion-record.ts";
import { transitionStateOrDie } from "./work-transition.ts";

/** The vocabulary's null: pre-F4 rows (fail_reason column absent/NULL). */
export const FAIL_REASON_UNKNOWN = "unknown";

/** the LaunchFailure.kind for a note — classifyLaunchFailure is the ONE
 *  classifier (launch-backoff.ts); an unclassifiable note still yields the
 *  enumerated "unknown", never a NULL. */
export const failKindOfNote = (note: string): string =>
	classifyLaunchFailure(note, Date.now()).kind;

/** The fail verb's handler (the bin keeps argv, this owns the write):
 *  transition → FAILED through the shared writer, stamp the classified
 *  reason on the row + event payload. Returns the kind for the CLI's exit
 *  line. */
export function runFailVerb(
	store: GovernorStore,
	project: string,
	args: { id: string; note: string; as: string | null; epoch: number | null },
	emit: (kind: string, id: string, extra: Record<string, string>) => void,
	die: (m: string) => never,
): string {
	const kind = failKindOfNote(args.note);
	store.transaction(() => {
		// W1173/W1173.1.1: refuse on the retained record (caller ignored) —
		// an unavailable lookup dies too, never reads as "no record".
		const refusal = reactivationRefusalMessage(store, project, args.id);
		if (refusal) die(refusal);
		const it = store
			.query(
				"SELECT id, state, owner_sid FROM work_items WHERE project = ? AND id = ?",
			)
			.get(project, args.id) as {
			id: string;
			state: string;
			owner_sid: string | null;
		} | null;
		if (!it) die(`no such work item in this project: ${args.id}`);
		const as = args.as
			? resolveSidOf(store as unknown as Database, args.as)
			: null;
		if (
			as &&
			(it.owner_sid !== as || !["CLAIMED", "RUNNING"].includes(it.state))
		)
			die(
				`${args.id} is not an unfinished claim owned by ${as} — failure refused`,
			);
		// unfenced in state (the pre-W2333 semantics): without --as the write
		// transitions from the item's as-read state — an operator may fail a
		// READY item; the claim fence (epoch) still guards concurrency.
		transitionStateOrDie(
			store,
			project,
			it,
			args.epoch,
			"FAILED",
			die,
		);
		store
			.query(
				"UPDATE work_items SET fail_reason = ? WHERE project = ? AND id = ?",
			)
			.run(kind, project, args.id);
		emit("work.failed", args.id, { note: args.note, reason: kind });
	})();
	return kind;
}

