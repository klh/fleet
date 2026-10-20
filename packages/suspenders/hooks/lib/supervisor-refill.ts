// A Claude supervisor can start with an empty READY pool and mint work later.
// SessionStart records the work-event watermark; PostToolUse only re-injects
// the refill contract after a newer add/split event creates READY work.
import type { Database } from "bun:sqlite";
import type { HookInput } from "./hookio.ts";
import { openStore, projectIdentity } from "./govdb.ts";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "./session-state.ts";
import { subagentLaneSuffix } from "./subscribe-attach.ts";

type RefillState = { project: string; eventId: number; prompted: boolean };

const EVENT_SQL =
	"SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE kind IN ('work.added','work.shattered') AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.project') END = ?";

function lastEventId(db: Database, project: string): number {
	return (db.query(EVENT_SQL).get(project) as { id: number }).id;
}

export function supervisorRefillDirective(ready: number): string {
	return `SUPERVISOR DEFAULT: READY ${ready} > 0 — arm the refill loop now (once per session, skip if one is armed): /loop refill: keep this project's lanes full until the READY pool is drained. Tick: deliver new owner instructions to an active lane through coord message <sid> (or consult for a question), confirm receipt and let it adapt; never cancel the lane just to revise its prompt. Follow up the same lane after completion if it can update the result; create a new lane only for a separate redo. Verify finished lanes and close with work done --sha if the lane didn't; dispatch (no --item) to fill every free slot; if READY=0 and all lanes are done, CronDelete + report the drain; else reply: run bun ~/.claude/hooks/suspenders/bin/fleet-report.ts (one call, the installed face of the work report verb, W906) and emit its table verbatim in a fenced block, headed by one status line (lanes live x/N, READY n, dispatched); item numbers double as the #lanes?w=<id> deep-links (W890). Keep working owned items when slots are full.`;
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
		(hook as HookInput & { agent_id?: string }).agent_id
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
		return supervisorRefillDirective(ready);
	} catch {
		return ""; // advisory hook: a store miss never blocks a tool
	}
}
