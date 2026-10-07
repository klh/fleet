// coord.ts — the coordination event bus over governor.db: agents share state
// BY REFERENCE (short structured events + canonical facts), never by retelling
// it in prose. Direct SendMessage stays reserved for interrupts.
//
// usage:
//   bun ~/.claude/bin/coord.ts emit <kind> [--scope s] [--sha x] [--note "..."] [--as sid]
//   bun ~/.claude/bin/coord.ts poll [--as sid] [--scope s] [--kinds a,b] [--limit n]
//   bun ~/.claude/bin/coord.ts wait --as sid [--scope s] [--kinds a,b] [--max-seconds 30]
//        (adaptive long-poll: 250ms fast path, backs off to 2s when idle)
//   bun ~/.claude/bin/coord.ts subscribe --as sid [--scope s] [--kinds a,b]
//        (W303: live WebSocket push on the store server — the real "always
//         on" subscribe, no polling, no relaunching, ever. Falls back to
//         wait --forever when no HTTP store is bound.)
//   bun ~/.claude/bin/coord.ts metrics [project] [--days N]
//   bun ~/.claude/bin/coord.ts bootstrap --as sid [--name label]
//        (--name stamps a user-facing lane name — coord fleet + the board show it)
//   bun ~/.claude/bin/coord.ts fact set <key> <value> [--source s]
//   bun ~/.claude/bin/coord.ts fact get <key> / fact list
//        (W466: machine cursor namespaces hidden; --prefix p / --limit n /
//         --all bound or lift the listing)
//   bun ~/.claude/bin/coord.ts diff [--since <seq|event-id>] [--last N] [--table t] [--json]
//        (row-image delta log: what changed in sessions/claims/locks/facts/
//         work_items between two points — events/cursors are the bus's own trail)
//   bun ~/.claude/bin/coord.ts events [--kinds a,b] [--last N] [--json]
//        (W430: the bus's own trail gets a CLI read — newest-first, --kinds
//         exact-match csv, --last N default 50)
//   bun ~/.claude/bin/coord.ts targets [--filter text] [--json]
//   bun ~/.claude/bin/coord.ts message <target-label-or-sid-or-substring> "text" [--as sid]
//   bun ~/.claude/bin/coord.ts message --all "text" [--as sid]
//   bun ~/.claude/bin/coord.ts hubs [--label name] [--json]
//        (W356: hub topology — labels from hubs.json + stack.yaml, candidate
//         walk with health probe; the first alive candidate is the hub URL)
//
// event kinds (doctrine): checkpoint | landed | interface_changed | test_red |

import { die, setRest } from "../coord/shared.ts";
import { CliError, runCli } from "../lib/cli.ts";
import { cli, VERBS } from "../coord/verbs.ts";

// routing, per-verb help and the verb list all come from the one declarative
// table (hooks/coord/verbs.ts) via the shared toolkit (hooks/lib/cli.ts);
// handlers keep reading raw rest through arg() — surface byte-compatible
const flow = (() => {
	try {
		return runCli(cli, process.argv.slice(2));
	} catch (e) {
		die(e instanceof CliError ? e.message : String(e));
	}
})();
const { cmd, rest } = flow;
// W157: the 32-command handler bodies live in hooks/coord/*.ts; this entry
// dispatches through the declarative verb table. CLI surface byte-compatible.
setRest(rest);

await VERBS[cmd].run(rest);
