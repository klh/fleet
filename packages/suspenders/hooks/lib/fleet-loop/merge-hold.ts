// fleet-loop/merge-hold.ts — W1302.1: the operator merge hold as a contract,
// not a bare marker (A2, docs/workflow-adjustments-2026-10-25.md: a bare
// existsSync `.fleet/merge-hold` outlived the quiet window it described and
// deferred all merges until someone remembered to delete it). The hold file
// now carries provenance — owner, reason, expiresAt (ISO-8601 string or
// epoch ms) — and the controller enforces it: a hold missing a field,
// unparseable, or expiring beyond the 7-day cap is refused; an expired hold
// ages out. Both are set aside (.rejected / .expired) with a NEED_DECISION
// so the ladder never defers forever. mergeHoldActive stays pure (one
// existsSync + one read) for the ladder's per-branch gates; enforceMergeHold
// is the controller's once-per-entry side effect.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../govdb/govdb.ts";
import { emitLoopEvent } from "./events.ts";

// a hold may never defer the ladder for more than a week — an operator quiet
// window is hours-to-days; anything longer is a posture change, not a hold.
const MAX_HOLD_MS = 7 * 24 * 60 * 60_000;

export const MERGE_HOLD_FILE = ".fleet/merge-hold";

/** The normalized in-memory hold (the file's expiresAt may be ISO or ms). */
export type MergeHold = {
	owner: string;
	reason: string;
	expiresAt: number;
};

export type MergeHoldView =
	| { state: "none" }
	| { state: "active"; hold: MergeHold }
	| { state: "expired"; hold: MergeHold }
	| { state: "malformed"; why: string };

const holdPath = (repo: string): string => join(repo, ".fleet", "merge-hold");

const expiresAtMs = (raw: unknown): number | null => {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
	if (typeof raw === "string" && raw.trim()) {
		const ms = Date.parse(raw);
		if (Number.isFinite(ms)) return ms;
	}
	return null;
};

/** Read + validate the hold: pure, never throws, no side effects. */
export function readMergeHold(repo: string): MergeHoldView {
	if (!existsSync(holdPath(repo))) return { state: "none" };
	let raw: string;
	try {
		raw = readFileSync(holdPath(repo), "utf8");
	} catch (e) {
		return {
			state: "malformed",
			why: `unreadable: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { state: "malformed", why: "not valid JSON" };
	}
	if (typeof parsed !== "object" || parsed === null)
		return { state: "malformed", why: "not a JSON object" };
	const rec = parsed as Record<string, unknown>;
	const owner = typeof rec.owner === "string" ? rec.owner.trim() : "";
	if (!owner) return { state: "malformed", why: "missing owner" };
	const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
	if (!reason) return { state: "malformed", why: "missing reason" };
	const at = expiresAtMs(rec.expiresAt);
	if (at === null)
		return { state: "malformed", why: "missing or invalid expiresAt" };
	if (at > Date.now() + MAX_HOLD_MS)
		return {
			state: "malformed",
			why: `expiresAt beyond the ${MAX_HOLD_MS / 86_400_000}-day hold cap`,
		};
	const hold = { owner, reason, expiresAt: at };
	return at <= Date.now()
		? { state: "expired", hold }
		: { state: "active", hold };
}

/** THE ladder hold predicate (W1072.2 gate, W1302.1 contract): true only for
 * a present, well-formed, unexpired hold. Malformed/expired/unreadable holds
 * read as inactive — the fail-open direction is deliberate (A2: the failure
 * mode that matters is deferring all merges forever, not one merge too many);
 * enforceMergeHold is what makes that safe by refusing them loudly. */
export function mergeHoldActive(repo: string): boolean {
	return readMergeHold(repo).state === "active";
}

/** Controller-side enforcement, once per mode entry (cycle, flush, ship):
 * set an expired/malformed hold aside, raise NEED_DECISION, never throw.
 * Returns the (post-enforcement) active state. */
export function enforceMergeHold(
	repo: string,
	log: (line: string) => void,
): boolean {
	const view = readMergeHold(repo);
	if (view.state === "none") return false;
	if (view.state === "active") return true;
	const expired = view.state === "expired";
	const suffix = expired ? ".expired" : ".rejected";
	const why = expired
		? `owner=${view.hold.owner} expired at ${new Date(view.hold.expiresAt).toISOString()}`
		: view.why;
	const file = `${MERGE_HOLD_FILE}${suffix}`;
	try {
		renameSync(holdPath(repo), `${holdPath(repo)}${suffix}`);
	} catch {
		/* already set aside by a concurrent entry; the event below still fires */
	}
	log(
		`HOLD-${expired ? "EXPIRED" : "REJECTED"} ${MERGE_HOLD_FILE} — ${why}; set aside as ${file}, merges resume`,
	);
	emitLoopEvent("NEED_DECISION", "merge-hold", {
		project: projectIdentity(repo),
		reason: expired
			? `expired operator merge hold (owner ${view.hold.owner}, reason: ${view.hold.reason}) set aside as ${file}; ladder resumes`
			: `malformed operator merge hold (${why}) set aside as ${file}; ladder resumes — a hold requires owner, reason and expiresAt (≤7 days)`,
		...(expired
			? { owner: view.hold.owner, expiresAt: view.hold.expiresAt }
			: {}),
	});
	return false;
}
