// writes.ts — W2328: dataplane v0.1 writes — WorkItems Create/Update/
// soft-Delete and Lanes Message/Steer. Every mutation rides the SAME lib
// path the CLI verb calls (design law: the dataplane is a face, not a second
// control plane), so every dataplane mutation emits the same event kind the
// CLI emits — parity by construction, proven by the co-situated e2e.
//   Create → work-graph.ts insertItem + emit("work.added")   (the add verb)
//   Update → work-edit.ts editWorkItem + emit("work.edited") (the edit verb)
//   Delete → setState(CANCELLED) + releaseClaim + emit("work.cancelled")
//                                                          (the cancel verb)
//   Message → coord bus DIRECT_MESSAGE emit + directed receipt (coord message)
//   Steer  → coord steer gates + emit (the steer verb's own enforcement)
import { DIRECT_MESSAGE_KIND } from "../../coord/addressing.ts";
import { emitEvent, queueDirectedReceipt } from "../../coord/bus.ts";
import type { SteerOutcome } from "../../coord/steer-lane.ts";
import { steerLane } from "../../coord/steer-lane.ts";
import { reproGateRefusal } from "../gates/repro-gate.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { nextChildIdOf } from "../work/work-alloc.ts";
import {
	type EditedField,
	editPayload,
	editWorkItem,
} from "../work/work-edit.ts";
import {
	emit as emitWorkEvent,
	insertItem,
	nextRootId,
	releaseClaim,
	setState,
} from "../work/work-graph.ts";
import { DataplaneProblem } from "./problems.ts";
import type {
	CreateWorkItemRequest,
	UpdateWorkItemRequest,
} from "./schemas.ts";
import type { WorkItemRow } from "./work-items.ts";
import { getWorkItem, WORK_ITEM_NAME } from "./work-items.ts";

/** name → (project, id); the project segment URL-decodes so a path-shaped
 *  identity round-trips. Unknown shape → invalid_argument. */
export const parseWorkItemName = (
	name: string,
): { project: string; id: string } => {
	const m = WORK_ITEM_NAME.exec(name);
	if (!m)
		throw new DataplaneProblem(
			"invalid_argument",
			`malformed work item name: ${name}`,
		);
	return { project: decodeURIComponent(m[1] ?? ""), id: m[2] ?? "" };
};

/** WorkItems/Create (AIP-133) — mints through insertItem (the add verb's ONE
 *  writer) with the W743 repro gate enforced, event parity included. */
export function createWorkItem(
	db: GovernorStore,
	project: string,
	req: CreateWorkItemRequest,
): WorkItemRow {
	const repro = reproGateRefusal(
		db,
		project,
		`${req.title} ${req.description ?? ""}`,
	);
	if (repro) throw new DataplaneProblem("failed_precondition", repro);
	if (req.parent) {
		const parent = db
			.query("SELECT id FROM work_items WHERE project = ? AND id = ?")
			.get(project, req.parent);
		if (!parent)
			throw new DataplaneProblem(
				"not_found",
				`parent ${req.parent} does not exist in this project`,
			);
	}
	const id = req.parent
		? nextChildIdOf(db, project, req.parent)
		: nextRootId(db, project);
	insertItem(
		id,
		req.parent ?? null,
		req.title,
		req.scope ?? null,
		req.priority ?? 0,
		"dataplane",
		req.reason ?? null,
		null,
		req.description ?? null,
		null,
		req.evidence ?? null,
		req.tags?.join(",") ?? null,
		db,
	);
	emitWorkEvent("work.added", id, { scope: req.scope ?? "" }, "work", db);
	return getWorkItem(db, project, id);
}

/** Edit refusals map onto the AIP vocabulary: missing item = not_found,
 *  terminal-state and other enforcement = failed_precondition. */
const editRefusal = (error: string): DataplaneProblem =>
	new DataplaneProblem(
		error.includes("no such work item") ? "not_found" : "failed_precondition",
		error,
	);

/** WorkItems/Update (AIP-134) — editWorkItem (the edit verb's ONE writer);
 *  update_mask narrows which mutable fields the call may carry (omitted mask
 *  = all of title/description/priority/tags). Event parity: work.edited with
 *  the per-field prior values, exactly the CLI payload. */
export function updateWorkItem(
	db: GovernorStore,
	project: string,
	req: UpdateWorkItemRequest,
): { work_item: WorkItemRow; changed: Record<string, EditedField> } {
	const ref = parseWorkItemName(req.name);
	if (ref.project !== project)
		throw new DataplaneProblem(
			"permission_denied",
			`name outside this graph's project: ${req.name}`,
		);
	const patch = {
		title: req.title,
		desc: req.description,
		priority: req.priority,
		tag: req.tags?.join(","),
	};
	const mask = req.update_mask ?? Object.keys(patch);
	for (const field of mask)
		if (!(field in patch))
			throw new DataplaneProblem(
				"invalid_argument",
				`unknown update_mask path: ${field}`,
			);
	const present = (Object.keys(patch) as (keyof typeof patch)[]).filter(
		(k) => patch[k] !== undefined,
	);
	for (const field of present)
		if (!mask.includes(field))
			throw new DataplaneProblem(
				"invalid_argument",
				`field outside update_mask: ${field}`,
			);
	const r = editWorkItem(db, ref.project, ref.id, patch);
	if (!r.ok) throw editRefusal(r.error);
	if (Object.keys(r.changed).length > 0)
		emitWorkEvent(
			"work.edited",
			ref.id,
			editPayload(r.changed, req.reason ?? ""),
			"work",
			db,
		);
	return {
		work_item: getWorkItem(db, ref.project, ref.id),
		changed: r.changed as Record<string, EditedField>,
	};
}

/** WorkItems/Delete (AIP-135, soft) — the CANCELLED transition (the cancel
 *  verb's own path in one tx: terminal refusal, state CAS, claim release,
 *  work.cancelled emit). NOT done here: the CLI's post-cancel worktree
 *  retirement — a remote API call does not retire git worktrees; that stays
 *  the CLI cancel's job (documented divergence, not a second writer). */
const DELETE_REFUSES = [
	"DONE",
	"FAILED",
	"SUPERSEDED",
	"CANCELLED",
	"SHATTERED",
];
export function deleteWorkItem(
	db: GovernorStore,
	project: string,
	name: string,
	note: string,
): WorkItemRow {
	const ref = parseWorkItemName(name);
	if (ref.project !== project)
		throw new DataplaneProblem(
			"permission_denied",
			`name outside this graph's project: ${name}`,
		);
	db.transaction(() => {
		const it = db
			.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
			.get(project, ref.id) as
			| (Record<string, string | number | null> & { id: string })
			| undefined;
		if (!it)
			throw new DataplaneProblem("not_found", `no such work item: ${ref.id}`);
		if (DELETE_REFUSES.includes(String(it.state)))
			throw new DataplaneProblem(
				"failed_precondition",
				`${ref.id} is ${it.state} — already closed`,
			);
		setState(ref.id, "CANCELLED", null, undefined, db);
		releaseClaim(
			(it.owner_sid as string) ?? "",
			(it.scope as string | null) ?? null,
			ref.id,
			db,
		);
		emitWorkEvent("work.cancelled", ref.id, { note }, "work", db);
	})();
	return getWorkItem(db, project, ref.id);
}

// ---- Lanes custom methods (Message/Steer) --------------------------------

/** Lane name → sid; `lanes/{sid}` (AIP-122, fleet-wide collection). */
export const parseLaneName = (name: string): string => {
	const m = /^lanes\/([^/]+)$/.exec(name);
	if (!m)
		throw new DataplaneProblem(
			"invalid_argument",
			`malformed lane name: ${name}`,
		);
	return decodeURIComponent(m[1]);
};

/** Lanes/Message — `coord message` semantics: one directed NOTE event to the
 *  lane, receipt queued, delivery contract unchanged. Resolution is by EXACT
 *  sid against the lane registry (the CLI's label/prefix/live matching and
 *  its cross-hub relay stay CLI-side: a server must not process.exit() on an
 *  unresolved needle). */
export function messageLane(body: {
	name: string;
	text: string;
	urgent?: boolean;
	source?: string;
}): { name: string; message_id: number; queued: boolean } {
	const sid = parseLaneName(body.name);
	const id = emitEvent({
		kind: DIRECT_MESSAGE_KIND,
		note: body.text,
		source: body.source ?? "dataplane",
		to: sid,
		extra: body.urgent ? { urgent: "1" } : {},
	});
	queueDirectedReceipt(id, sid);
	return { name: body.name, message_id: id, queued: true };
}

/** Lanes/Steer — `coord steer` semantics through steerLane (the verb's OWN
 *  gate sequence: pause kill switch, scrub ruleset, liveness, rate limit),
 *  no dataplane policy of its own. A refused steer never queues an event. */
export function steerViaLane(
	fleetRoot: string,
	body: { name: string; text: string; source?: string },
): {
	name: string;
	outcome: SteerOutcome;
	event_id: number | null;
	detail: string;
} {
	const sid = parseLaneName(body.name);
	const r = steerLane(sid, body.text, body.source ?? "dataplane", fleetRoot);
	if (r.outcome === "failed")
		throw new DataplaneProblem("failed_precondition", r.detail);
	return {
		name: body.name,
		outcome: r.outcome,
		event_id: r.eventId,
		detail: r.detail,
	};
}

/** Steer's registry pre-read (unused by the gates themselves — steerLane
 *  loads the registry again; the dataplane's registry root differs from
 *  cwd). Kept: the door imports nothing here it does not use. */
