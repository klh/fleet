// hooks/session-end.ts — SessionEnd: mark the session CLOSED in the control
// plane. Deliberately does NOT release owned work — a closed session may be
// resumed (coord resume-session); work stays with the owner until rebind or
// `work orphaned` → `work reclaim`.
//
// W159: the settle phase runs here too — provenance-sorted knowledge
// write-back (hooks/lib/settle.ts). Degrade-honest: a settle failure logs to
// stderr and NEVER blocks the session closing.
import { openGovernorDb } from "./lib/govdb.ts";
import { settleSession } from "./lib/settle.ts";
import { retireTopLevel } from "./lib/hook-scripts.ts";

// W514 (claudecode research §1.8): the SessionEnd payload is tiny — race
// the stdin read against 1 s so a detached or late-stdin invocation (async
// wiring, dialect bridge) can never hang teardown.
const raw = await Promise.race([
	new Response(Bun.stdin.stream()).text(),
	new Promise<string>((resolve) => setTimeout(() => resolve(""), 1_000)),
]);
let input: { session_id?: string } = {};
try {
	input = JSON.parse(raw) as { session_id?: string };
} catch {
	// empty/dead stdin: nothing to close — exit clean below
}
if (input.session_id) {
	openGovernorDb()
		.query("UPDATE sessions SET state = 'CLOSED', hb = ? WHERE sid = ?")
		.run(Date.now(), input.session_id);
	try {
		const r = await settleSession(input.session_id);
		if (r.queueMarked > 0 || r.rowsBackfilled > 0)
			console.error(
				`[settle] ${r.sid.slice(0, 8)} domain=${r.domain} queue=${r.queueMarked} rows=${r.rowsBackfilled}`,
			);
	} catch (e) {
		console.error(`[settle] degraded (session end proceeds): ${String(e)}`);
	}
	// W422.17.1: retire the session's enrolled buckle key — revoke + 0600
	// file cleanup, the same lane lifecycle (retireLaneKey). Only fires when
	// a meta file exists (subagents / never-enrolled sessions skip); the
	// 24h TTL is the backstop for sessions that die un-ended. Degrade-honest:
	// a retire failure logs to stderr, never blocks the close.
	try {
		await retireTopLevel({
			hookDir: import.meta.dir,
			sid: input.session_id,
			cwd: process.cwd(),
		});
	} catch (e) {
		console.error(
			`[enroll] retire degraded (session end proceeds): ${String(e)}`,
		);
	}
}
process.exit(0);
