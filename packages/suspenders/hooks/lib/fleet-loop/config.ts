// fleet-loop/config.ts — argv → LoopConfig for the fleet-loop entrypoint
// (W740 split): one parse, one usage block, the loop shell's knob set.
// val/num are exported for the entrypoint's flush/ship mode blocks.

import { resolve } from "node:path";
import { z } from "zod";
import { canonicalProjectRoot } from "../lanes/lane-registry.ts";
import { loopDie } from "./loop-errors.ts";

/** W2173.7 zod-first: the schema is THE definition of the loop's parsed
 *  argv config; the type is derived, never hand-written. */
export const LoopModeSchema = z.enum([
	"once",
	"watch",
	"lanes",
	"dispatch",
	"flush",
	"ship",
	"posture",
]);

export const LoopConfigSchema = z.object({
	/** re-passed to `once` children by watch mode */
	argv: z.array(z.string()),
	MODE: LoopModeSchema,
	/** the entrypoint's import.meta.dir — dialect wire paths anchor here */
	binDir: z.string().min(1),
	REPO: z.string().min(1),
	CALLER_REPO: z.string().min(1),
	MAIN: z.string().min(1),
	GLOB: z.string().min(1),
	LADDER: z.string().optional(),
	AGENT: z.string().min(1),
	EFFORT: z.string().optional(),
	LADDER_TIMEOUT_MS: z.number().nonnegative(),
	DISPATCH: z.string().optional(),
	EVERY_MS: z.number().nonnegative(),
	CYCLE_TIMEOUT_MS: z.number().nonnegative(),
	LOG: z.string().min(1),
	FAILS: z.string().min(1),
	STALL_WARN_MS: z.number().nonnegative(),
});
export type LoopConfig = z.infer<typeof LoopConfigSchema>;

// flag lookups close over a specific argv — parseLoopConfig and the
// entrypoint's flush/ship blocks share this one definition (W740)
export const flagFns = (argv: string[]) => {
	const val = (flag: string, dflt?: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : dflt;
	};
	const num = (flag: string, dflt: number): number =>
		Number(val(flag, String(dflt)));
	return { val, num };
};

export function parseLoopConfig(argv: string[], binDir: string): LoopConfig {
	const { val, num } = flagFns(argv);
	const MODE = argv[0];
	if (
		!MODE ||
		!LoopModeSchema.safeParse(MODE).success ||
		!argv.includes("--repo")
	) {
		loopDie(
			"loop.usage",
			`usage: fleet-loop once|watch|lanes|dispatch|ship|posture --repo <dir> [--glob lane/autow*] [--main main]\n` +
				`          posture [steady|plaid]        the W911 plaid switch — read shows; arg writes\n` +
				`          [--ladder <cmd template with {branch}>]  default: plain git merge --no-ff\n` +
				`          [--ladder-timeout 10]                    minutes; watchdog-kills a hung ladder\n` +
				`          [--dispatch-cmd <template>]              optional policy script\n` +
				`          [--agent claude|codex]                   dispatch backend (default claude)\n` +
				`          ship --branch <branch>                   one branch through the ladder (board ship trigger)\n` +
				`          flush --repo <dir> [--item <id>] [--await <secs>]   merge DONE+verified branches (W641); --item waits out the closing lane first (W249)\n` +
				`          [--every 120] [--cycle-timeout 15] [--log <file>]   (watch mode)\n`,
			MODE ? 1 : 0,
		);
	}
	const requestedRepo = val("--repo");
	if (!requestedRepo)
		loopDie("loop.config_invalid", "--repo <dir> is required");
	const CALLER_REPO = resolve(requestedRepo);
	const REPO = canonicalProjectRoot(CALLER_REPO);
	const MAIN = val("--main", "main");
	const GLOB = val("--glob", "lane/autow*");
	const LADDER = val("--ladder");
	const AGENT = val("--agent", "claude");
	const EFFORT = val("--effort"); // W183.1 — copilot --reasoning-effort passthrough
	const LADDER_TIMEOUT_MS = num("--ladder-timeout", 10) * 60_000;
	const DISPATCH = val("--dispatch-cmd");
	const EVERY_MS = num("--every", 120) * 1000;
	const CYCLE_TIMEOUT_MS = num("--cycle-timeout", 15) * 60_000;
	const LOG = val("--log", `${REPO}/.fleet/loop.log`);
	const FAILS = `${REPO}/.fleet/merge-fails.json`;
	return LoopConfigSchema.parse({
		argv,
		MODE,
		binDir,
		REPO,
		CALLER_REPO,
		MAIN,
		GLOB,
		LADDER,
		AGENT,
		EFFORT,
		LADDER_TIMEOUT_MS,
		DISPATCH,
		EVERY_MS,
		CYCLE_TIMEOUT_MS,
		LOG,
		FAILS,
		STALL_WARN_MS: num("--stall-warn-min", 10) * 60_000,
	});
}
