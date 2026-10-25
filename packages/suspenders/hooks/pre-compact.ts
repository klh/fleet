// hooks/pre-compact.ts — PreCompact hook: the last-moment roll (W253).
// Compaction is about to discard the session's working context; bank the
// plane-derived header (branch/head, owned items, capsule) to the rolling
// checkpoint while the plane is still authoritative. Agent-owned done/next
// bullets survive the roll. Degrade-honest: a failure logs to stderr and
// NEVER blocks compaction. Register as a second PreCompact hook:
//   PreCompact → bun ~/.claude/hooks/suspenders/pre-compact.ts
import { openStore, projectIdentity } from "./lib/govdb/govdb.ts";
import { rollCheckpoint, type CheckpointDb } from "./lib/checkpoint.ts";
import { subagentLaneSuffix } from "./lib/subscribe-attach.ts";

type In = { session_id?: string; transcript_path?: string; trigger?: string };

const raw = await new Response(Bun.stdin.stream()).text();
let input: In = {};
try {
	input = JSON.parse(raw) as In;
} catch {
	process.exit(0);
}
if (!input.session_id) process.exit(0);

// same lane discriminator as session-start.ts: Claude Code gives subagent
// lanes the PARENT's session_id; their transcript path carries the lane name
const suffix = subagentLaneSuffix(input.transcript_path ?? "");
const lane = suffix ? `${input.session_id}${suffix}` : input.session_id;

try {
	const r = rollCheckpoint(
		openStore() as unknown as CheckpointDb,
		projectIdentity(input.cwd ?? process.cwd()),
		lane,
		{
			cwd: input.cwd ?? process.cwd(),
			auto: input.trigger ?? "auto",
		},
	);
	process.stderr.write(
		`[checkpoint] rolled gen ${r.gen} → ${r.path} (pre-compact)\n`,
	);
} catch (e) {
	process.stderr.write(
		`[checkpoint] degraded (compaction proceeds): ${String(e)}\n`,
	);
}
process.exit(0);
