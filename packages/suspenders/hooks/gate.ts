#!/usr/bin/env bun
// ~/.claude/hooks/gate.ts — THE single hook entrypoint.
// Every hook registration is `bun gate.ts <event>`; this file owns stdin and
// nothing else. The event switch lives in gate-dispatch.ts (lazy per-event
// imports), gate logic in gates/*.ts, contracts in lib/hookio.ts.
//
//   bun gate.ts pre-bash    PreToolUse  (Bash: secrets/governor-lease/edit/skill/tool gates)
//   bun gate.ts pre-files   PreToolUse  (Edit|Write|NotebookEdit: leases → mutation-size →
//                            operational-marker → config-guard — ONE process, W14)
//   bun gate.ts post-files  PostToolUse (Edit|Write: syntax gate + md-format)
//   bun gate.ts governor    PreToolUse  (standalone lease check; pre-files chains it
//                            in-process, so the separate registration is now redundant)
//   bun gate.ts push        PostToolUse (W417.4: subscribe-log tail → context,
//                            offset per lane)
//   bun gate.ts stop        Stop        (claim-done gate)
//   bun gate.ts session     SessionStart (optional operator motd)
//
// Hub-of-one phase 5: with SUSPENDERS_GATE_DAEMON=1 the hot events
// (lib/gate-daemon/schema.ts DAEMON_EVENTS) are evaluated by the warm hub
// governor (store-server POST /gate/<event>, loopback only). Any daemon
// failure falls back to evaluating the same gate here — never fail-open.
import { gateViaDaemon } from "./lib/gate-daemon/client.ts";
import { parseHook } from "./lib/hookio.ts";

const event = process.argv[2] ?? "";
const raw = await new Response(Bun.stdin).text();

const remote = await gateViaDaemon(event, raw);
if (remote) {
	if (remote.stdout) process.stdout.write(remote.stdout);
	if (remote.stderr) process.stderr.write(remote.stderr);
	process.exit(remote.code);
}

const { dispatchGate } = await import("./gate-dispatch.ts");
await dispatchGate(event, parseHook(raw));
// every gate decides and exits; a gate that returned is an allow
process.stdout.write("{}");
process.exit(0);
