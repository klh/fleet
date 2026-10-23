// dispatch-usage.ts — W1124.33: the dispatch ROOT usage text + the shared
// verb-head discovery the family doors route by. The usage interpolates the
// verb-family doors' root entries (launch-intent-cli.ts / registry-cli.ts),
// so the verb enumerations derive from the shipped verb specs (schema
// discovery) — the b336 root help kept listing `intent inspect|fail` and
// `registry list|prune|forget` after reconcile-birth and repair-pid shipped.
// The verb head is the first token that is neither a flag nor a value-taking
// global flag's value, so `--repo <dir> intent reconcile-birth --help` routes
// identically to verb-first `dispatch intent reconcile-birth --help`.
import { INTENT_ROOT_HELP_ENTRY } from "./launch-intent-cli.ts";
import { REGISTRY_ROOT_HELP_ENTRY } from "./registry-cli.ts";

// the root door's value-taking flags — a token after one of these is the
// flag's VALUE, never the verb head (`--repo <dir> intent ...`).
const GLOBAL_VALUE_FLAGS = new Set([
	"--repo",
	"--target",
	"--item",
	"--route",
	"--show-capsule",
	"--resume-from",
]);

/** Index of the verb head, or -1 when argv names no verb (pure flag argv
 * like `dispatch --help` rides the root usage). */
export const verbHeadIndex = (tokens: string[]): number =>
	tokens.findIndex(
		(t, i) =>
			!t.startsWith("-") &&
			(i === 0 || !GLOBAL_VALUE_FLAGS.has(tokens[i - 1] ?? "")),
	);

/** The dispatch root usage — family entries interpolated, never inlined. */
export const dispatchRootHelp = (): string => `Usage: dispatch [options]

Refill agent lanes from READY work and resume unfinished claims.

  --repo <dir>             Project checkout (default: Git root)
  --target <N>             Steady posture live lane target (default: 6);
                           plaid grows one attempted launch per cycle
  --dry-run                Preview without launching or changing claims
  --item <Wn>              Dispatch one specific work item
  --route <name>           Pin a plaid route for --item; no model fallback
  --no-belt                Skip belt executor selection
  --allow-ungoverned       Explicitly allow a surfaced governance bypass
  --show-capsule <sid>      Print a lane's saved continuation capsule
  --resume-from <sid>       With --item: resume the prior lane's transcript
                            (claude --resume --fork-session). Policy-gated:
                            SUSPENDERS_RESUME_RETAKE=on + cache-warm
                            transcript fence; any miss = fresh + capsule.
${REGISTRY_ROOT_HELP_ENTRY}
${INTENT_ROOT_HELP_ENTRY}
  -h, --help               Print this help without dispatching

Crash recovery defaults to three total launches per lane.
Set SUSPENDERS_CLAUDE_BIN or SUSPENDERS_COPILOT_BIN to an absolute executable path.
Set SUSPENDERS_LANE_MAX_ATTEMPTS to a value from 1 to 100 to override.`;
