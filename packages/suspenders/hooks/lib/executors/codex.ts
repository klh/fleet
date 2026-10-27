// hooks/lib/executors/codex.ts — the codex CLI adapter (W422 law: one file
// per agent; facts verified W73/W296 + the 0.158 binary probes).
import type { ExecutorAdapter } from "../lanes/lane.ts";
import { codexEvidence } from "./codex-evidence.ts";
import type { ExecutorAdapter, LaneRide } from "../lanes/lane.ts";

/** W1712: a pinned codex lane rides its own Buckle /w/<sid>/v1/responses via
 *  per-invocation `-c` overrides (dotted path, TOML value — verified on the
 *  0.158 `exec --help`) — the seat's CODEX_HOME (hooks.json gates, session
 *  harvest) stays; the key rides env, only its NAME is in argv. */
export const codexRideArgs = (ride: LaneRide): string[] =>
	(
		[
			["model", ride.model],
			["model_provider", "buckle_lane"],
			["model_providers.buckle_lane.name", "buckle lane"],
			["model_providers.buckle_lane.base_url", ride.base],
			["model_providers.buckle_lane.env_key", ride.keyEnv],
			["model_providers.buckle_lane.wire_api", "responses"],
			["model_reasoning_effort", ride.effort],
		] as const
	).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]);

export const codexAdapter: ExecutorAdapter = {
	id: "codex",
	names: ["codex"],
	bin: "codex",
	spawnable: true,
	// codex >=0.158 hard-errors on wire_api="chat" (buckle agents.ts recipe)
	wire: "responses",
	// No observed codex brief mangling — warn-only (verifyBrief has no codex
	// profile yet; adding one = one brief-verify row, zero core branches).
	briefHarness: "claude",
	briefHardGate: false,
	// The codex spawn recipe is fleet-loop's (`exec` subcommand, prompt LAST)
	// — cataloged here for the fleet-loop registry conversion; dispatch core
	// never spawns codex via spawnClaude.
	spawnArgs: () => ["--sandbox", "danger-full-access"],
	promptArgs: (prompt) => ["exec", prompt],
	// W1009.1: exec's prompt is a bare trailing positional — the flag tail
	// precedes it (fleet-loop dispatch.ts:418 recipe, byte-verified).
	promptLast: true,
	modelArgs: codexRideArgs,
	// `exec resume <id>` chaining verified on the 0.158 binary (W454 probe);
	// wiring waits on the spawn-recipe composition (module header, W454).
	forkArgs: () => null,
	// seatbelt workspaces + AGENTS.md sandbox facts live in the codex dialect
	// (hooks/dialects/codex/) until fleet-loop rides the registry.
	processNames: ["codex"],
	// W1731: CODEX_SANDBOX / CODEX_CI / CODEX_THREAD_ID → "codex".
	detect: { names: ["codex"] },
	evidence: codexEvidence,
};
