// A Claude supervisor can start with an empty READY pool and mint work later.
// SessionStart records the work-event watermark; PostToolUse only re-injects
// the advisory contract after a newer add/split event creates READY work.
import type { Database } from "bun:sqlite";
import type { HookInput } from "../hookio.ts";
import {
	openStore,
	projectIdentity,
	projectRootOf,
	type GovernorStore,
} from "../govdb/govdb.ts";
import { join } from "node:path";
import { dispatchHeld } from "../../../scripts/lib/refill-window.ts";
import { automaticRecoveryPaused } from "../fleet-loop/automatic-recovery.ts";
import {
	observeControllerLease,
	controllerHolderLiveness,
} from "../../../scripts/lib/controller-fence.ts";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "../session-state.ts";
import { subagentLaneSuffix } from "../subscribe-attach.ts";
// W1124.12: worker-role lanes never arm the refill loop (mid-session either).
import { sessionRole } from "../coordinator-edit-gate.ts";

type RefillState = { project: string; eventId: number; prompted: boolean };

const EVENT_SQL =
	"SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE kind IN ('work.added','work.shattered') AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.project') END = ?";

function lastEventId(db: Database, project: string): number {
	return (db.query(EVENT_SQL).get(project) as { id: number }).id;
}

// W1069: the supervisor contract body — THE single source. The SessionStart
// bootstrap emits it at every top-level session (READY pool empty or not),
// the advisory READY notice composes it, and the push gate re-emits the
// composed form mid-session. Prose homes outside the installed hook (the
// global CLAUDE.md paragraph, repo AGENTS.md) are pointers, never copies:
// edit here, install, and every session's next bootstrap carries the change.
function contractBody(): string {
	return "This session is an observer, not a grant of controller authority. Do not arm a per-session refill cron or run a global prune/reclaim sweep. The fenced Suspenders controller owns dispatch and automatic recovery; it must recheck canonical authority, liveness and dispatch/reclaim holds before each action. An absent or unknown controller requires explicit owner coordination, never an automatic replacement loop. New owner instructions reach an active lane through coord message <sid> (or consult for a question), confirm receipt and let it adapt; never cancel the lane just to revise its prompt. Keep original claim context and baseline intact. DONE records branch completion, not integration: review immutable evidence before canonical guarded landing; never close another lane merely from a summary. Report with work report and emit its table verbatim, headed by one evidence-based status line. Keep working owned items while the controller manages capacity.";
}

export function supervisorControlStatus(
	store: GovernorStore,
	project: string,
): string {
	try {
		const repo = projectRootOf(project);
		const lease = observeControllerLease(store, project);
		const state = lease ? controllerHolderLiveness(lease) : "absent";
		return `CONTROL SNAPSHOT: controller=${state}; dispatch=${dispatchHeld(join(repo, ".fleet")) ? "held" : "not-held"}; reclaim=${automaticRecoveryPaused(repo) ? "held" : "not-held"}. Snapshot is not authorization.`;
	} catch {
		return "CONTROL SNAPSHOT: controller/holds=unknown. No controller authority granted.";
	}
}

export function supervisorRefillDirective(
	ready: number,
	status = "Controller authority unverified.",
): string {
	return `SUPERVISOR DEFAULT: READY ${ready} > 0 — advisory only. ${status} ${contractBody()}`;
}

// W1069: the READY=0 bootstrap face — same body, neutral header. Every
// top-level session (any project) receives the live contract at bootstrap,
// so a fresh non-fleet session supervising future work never falls back to
// stale prose recalled from a global config file.
export function supervisorContractNotice(
	status = "Controller authority unverified.",
): string {
	return `SUPERVISOR CONTRACT (current installed guidance, advisory only): ${status} ${contractBody()}`;
}

export function seedSupervisorRefill(
	db: Database,
	project: string,
	sid: string,
	ready: number,
): void {
	writeSessionState(sessionStatePath("supervisor-refill", sid), {
		project,
		eventId: lastEventId(db, project),
		prompted: ready > 0,
	} satisfies RefillState);
}

export function midSessionSupervisorRefill(
	hook: HookInput,
	pushed = "",
): string {
	const sid = hook.session_id;
	if (!sid || process.env.CLAUDE_FLEET_BOOTSTRAP === "0") return "";
	if (
		subagentLaneSuffix(hook.transcript_path ?? "") ||
		(hook as HookInput & { agent_id?: string }).agent_id ||
		// W1124.12: a worker-role lane executes its claim — it never arms
		// the refill loop mid-session either (same ruling as session-start).
		sessionRole(hook.cwd ?? process.cwd()) === "lane"
	)
		return "";
	const command = hook.tool_input?.command ?? "";
	if (
		!/\bwork(?:\.ts)?\s+(?:add|split)\b/.test(command) &&
		!/\bwork\.(?:added|shattered)\b/.test(pushed)
	)
		return "";
	try {
		const project = projectIdentity(hook.cwd ?? process.cwd());
		const path = sessionStatePath("supervisor-refill", sid);
		const state = readSessionState<RefillState>(path);
		if (state?.project === project && state.prompted) return "";
		const store = openStore();
		const session = store
			.query("SELECT parent_sid FROM sessions WHERE sid = ? AND project = ?")
			.get(sid, project) as { parent_sid: string | null } | null;
		if (
			session?.parent_sid ||
			(process.env.SUSPENDERS_SID && process.env.SUSPENDERS_SID !== sid)
		)
			return "";
		const eventId = lastEventId(store as Database, project);
		if (eventId <= (state?.project === project ? state.eventId : 0)) return "";
		const ready = (
			store
				.query(
					"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'",
				)
				.get(project) as { n: number }
		).n;
		if (ready === 0) return "";
		writeSessionState(path, {
			project,
			eventId,
			prompted: true,
		} satisfies RefillState);
		return supervisorRefillDirective(
			ready,
			supervisorControlStatus(store, project),
		);
	} catch {
		return ""; // advisory hook: a store miss never blocks a tool
	}
}
