// test/dispatch-next.test.ts — W145: suspenders dispatches its own fan-outs
// through the fleet machinery. Covered: the capsule write/read round-trip
// through the REAL coord verb (scratch-HOME governor db), dry-run dispatch
// (prints item + brief, spawns nothing, takes nothing), and resume-rebrief
// composition (dead lane's last capsule returns as RESUME CONTEXT).
//
// Suite entrypoint (W718 decomposition): the cohesive modules under
// test/dispatch-next/ register in import order — the scratch governor graph
// is shared and --target picks are FIFO-sensitive, so do not reorder.

import "./dispatch-next/fixtures.ts";
import "./dispatch-next/help-ownership-dryrun.ts";
import "./dispatch-next/brief-pool-chain.ts";
import "./dispatch-next/crash-resume.ts";
import "./dispatch-next/governance.ts";
import "./dispatch-next/governance-decisions.ts";
import "./dispatch-next/launch-lifecycle.ts";
