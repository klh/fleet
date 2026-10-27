// Native Claude children receive SubagentStart, not SessionStart. Register
// their own claim identity before their first prompt; never borrow the
// parent's worktree, claim or exemption.
import { join } from "node:path";
import { CAPABILITIES, openStore, projectIdentity } from "./lib/govdb/govdb.ts";
import { hookLaneId, hookSubagentSuffix } from "./lib/hook-lane.ts";
import { allow, context, readHook } from "./lib/hookio.ts";
import { attachSubscribe } from "./lib/lanes/subscribe-attach.ts";

if (process.env.CLAUDE_FLEET_BOOTSTRAP === "0") allow();
const hook = await readHook();
const sid = hookLaneId(hook);
const suffix = hookSubagentSuffix(hook);
if (!sid || !suffix || !hook.cwd) allow();
const parent = (hook.session_id ?? "").split("#")[0];
const project = projectIdentity(hook.cwd);
const path = hook.agent_transcript_path ?? hook.transcript_path ?? "";
const transcript = path.includes("/subagents/")
	? path
	: path.endsWith(".jsonl")
		? join(path.slice(0, -6), "subagents", `${suffix.slice(1)}.jsonl`)
		: null;
const db = openStore();
try {
	const mother = db
		.query("SELECT capabilities,actor FROM sessions WHERE sid=? AND project=?")
		.get(parent, project) as {
		capabilities: string | null;
		actor: string | null;
	} | null;
	const now = Date.now();
	db.query(
		"INSERT INTO sessions (sid,project,role,parent_sid,worktree,started_at,hb,state,capabilities,transcript_path,actor) " +
			"VALUES (?,?,'worker',?,NULL,?,?,'RUNNING',?,?,?) " +
			"ON CONFLICT(sid) DO UPDATE SET project=excluded.project,parent_sid=excluded.parent_sid,hb=excluded.hb,state='RUNNING'," +
			"capabilities=COALESCE(excluded.capabilities,sessions.capabilities),transcript_path=COALESCE(excluded.transcript_path,sessions.transcript_path)",
	).run(
		sid,
		project,
		parent,
		now,
		now,
		mother?.capabilities ?? CAPABILITIES.join(","),
		transcript,
		mother?.actor ?? null,
	);
} finally {
	db.close();
}
try {
	attachSubscribe(sid);
} catch {
	// Inbox availability must not prevent the child from learning its identity.
}
context(
	`SUBAGENT LANE ${sid} (parent ${parent}). ` +
		`Use this identity for claims and coordination: work take <item> --as ${sid}; coord subscribe --as ${sid}. ` +
		"Work inside the worktree printed by work take. Do not claim as the parent's session ID or invent a lane ID.",
	"SubagentStart",
);
