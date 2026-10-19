// scripts/lib/lane.ts — shared lane-spawn plumbing for the fleet scripts
// (W146). supervise.ts and dispatch-next.ts must drive IDENTICAL spawn
// recipes (env scrub, sh -c exec + stdin detach, lanes.json registry), so
// the recipes live here. dispatch-next's inline copies of the small read
// helpers (sh/run/loadLanes) stay until a lane can afford the churn —
// the mutation gate caps edits at 40 lines; the spawn/env core
// (the part a divergence would corrupt lanes with) is shared for real.
import {
	laneRegistryFile,
	loadLaneRegistry,
	mergeLaneRegistry,
} from "../../hooks/lib/lane-registry.ts";
import { attachSubscribe } from "../../hooks/lib/subscribe-attach.ts";
import { jobslabEnv, jobslabFor, jobslabPrefix } from "./jobslab.ts";

// W422 surface consolidation law: the spawn-args adapter INTERFACE. Core
// dispatch carries ZERO executor branches — every agent's specifics live in
// a tiny overlay module (hooks/lib/executors/<agent>.ts) registered in
// hooks/lib/executors/registry.ts; a new agent = one adapter file + one
// registry row. lane.ts itself imports no adapter: callers resolve one via
// the registry and hand its composed tail to spawnClaude's cliArgs.
/** Everything a per-agent spawn tail may consume (claude uses all of it;
 *  narrower executors ignore what their CLI lacks). */
export interface SpawnArgsSpec {
	/** Tool-permission recipe (claude --allowedTools grammar). */
	allowedTools?: string;
	/** Same-bin model fallbacks (claude --fallback-model chain tail). */
	fallbackModels?: string[];
	/** --settings file args (the 0600 lane settings pin). */
	settingsArgs?: string[];
	/** Starter-session fork args (W454). */
	forkArgs?: string[];
}

export interface ExecutorAdapter {
	/** Registry key + the .prefer/default_executors token. */
	id: string;
	/** Additional chain tokens this adapter owns (aliases). */
	names: string[];
	/** The CLI binary this executor spawns. */
	bin: string;
	/** false = catalog-only (resolveLaneExecutor refuses the token). */
	spawnable: boolean;
	/** W223.2 brief-verify harness id + enforcement: true = a failing brief
	 *  REFUSES the dispatch (claude/codex run warn-only). */
	briefHarness: "claude" | "copilot";
	briefHardGate: boolean;
	/** Post-prompt spawn arg tail (order-stable). */
	spawnArgs(spec: SpawnArgsSpec): string[];
	/** The args that carry the prompt (`-p <p>` for the claude dialects,
	 *  ["exec", <p>] for codex). */
	promptArgs(prompt: string): string[];
	/** W454 starter-session fork args; null = no fork support (cold start). */
	forkArgs(sessionId: string): string[] | null;
	/** W918.3: the one-turn starter-seed argv (claude JSON grammar). Absent
	 *  = not starter-seedable (cold start) — fork grammar alone never
	 *  implies the seed turn; copilot/codex have no verified seed recipe. */
	starterSeedArgs?: (seed: string) => string[];
	/** Process-table names this executor answers to (liveness matcher). */
	processNames: string[];
	/** PATH-independent install locations probed when `which` misses —
	 *  launchd agents run a bare /usr/bin:/bin PATH, so a versioned native
	 *  install must be discoverable without the shell's PATH (W626: the
	 *  launchd-context liveness read every lane unknown). */
	installPaths?: string[];
}

export const sh = (cmd: string[], cwd = process.cwd()): string => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
};

// W911 decomposition (dispatch-next hit the 1500-line law): the CLI prefix
// builders + the residue probe hoist here — the shared fleet-script plumbing.
export const workCliFor =
	(bin: string) =>
	(...args: string[]): string[] => [
		process.execPath,
		`${bin}/work.ts`,
		...args,
	];
export const coordCliFor =
	(bin: string) =>
	(...args: string[]): string[] => [
		process.execPath,
		`${bin}/coord.ts`,
		...args,
	];

// W349: retire+recreate a wrong-branch leftover — the SKIP line on failure,
// null on success. Retire refuses dirty trees (exit 3) so residue is never
// silently discarded.
export const recreateWorktreeFor = (
	item: string,
	bin: string,
): string | null => {
	const retired = run([process.execPath, `${bin}/worktree.ts`, "retire", item]);
	if (retired.code !== 0)
		return `SKIP ${item} — leftover worktree retire failed: ${retired.out.split("\n")[0]}`;
	const created = run([process.execPath, `${bin}/worktree.ts`, "create", item]);
	if (created.code !== 0)
		return `SKIP ${item} — worktree recreate failed: ${created.out.split("\n")[0]}`;
	return null;
};

// lane liveness is THE plane's verdict (2026-10-05): work lanes --json
// (hooks/lib/lane-liveness.ts) is the one source dispatch-next, fleet-loop
// and humans share — recycled pids and permanently-trusted host lanes both
// read dead now. Missing audit observations fall back to process identity;
// a failed identity probe conservatively retains the occupied slot.
export const laneAuditFor = (
	workCli: (...args: string[]) => string[],
	fleet: string,
): Map<string, boolean> => {
	try {
		const raw = sh(workCli("lanes", "--json", "--fleet", fleet));
		return new Map(
			(JSON.parse(raw) as Array<{ sid: string; live: boolean }>).map((a) => [
				a.sid,
				a.live,
			]),
		);
	} catch {
		return new Map();
	}
};

// W349 residue probe: git-state dirt the lane did NOT make — dispatch's own
// worktree artifacts (.klh-brief.md, .fleet/) are not residue. W874: an
// untracked node_modules at ANY depth (root install or per-package) is
// dependency debris, never work residue.
export const residueOf = (wt: string): string =>
	sh(["git", "-C", wt, "status", "--porcelain"])
		.split("\n")
		.filter((line) => {
			const p = line.slice(3).trim();
			return (
				line &&
				p !== ".klh-brief.md" &&
				!p.startsWith(".fleet/") &&
				!p.split("/").includes("node_modules")
			);
		})
		.join("\n");

export const run = (
	cmd: string[],
	cwd = process.cwd(),
): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};

// ONE liveness surface (W494.1): the hooks/lib probe replaced lane.ts's
// inline ps/lsof folk-magic copy (which matched /claude|codex/ comms only,
// blind to copilot/grok/cline) — supervise rides the law surface now.
export {
	laneProcessIdentity as alive,
	worktreeLive,
} from "../../hooks/lib/lane-liveness.ts";

export const lanesFileFor = laneRegistryFile;
export const loadLanes = (fleet: string): Lane[] =>
	loadLaneRegistry<Lane>(fleet);
export const saveLanes = (lanes: Lane[], fleet: string): void =>
	mergeLaneRegistry(fleet, lanes);

// env: belt routing rides into the lane (the launchd plist carries
// ANTHROPIC_BASE_URL/AUTH_TOKEN); model overrides must NOT — a GLM-routed
// shell hung a lane at model init (W57), so the whole family is scrubbed.
export const MODEL_ENV_KEYS = [
	"ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
];

export const laneEnv = (
	base: Record<string, string | undefined>,
	noBelt = false,
): Record<string, string> => {
	const env: Record<string, string> = { ...base };
	for (const k of MODEL_ENV_KEYS) delete env[k];
	if (noBelt) {
		delete env.ANTHROPIC_BASE_URL;
		delete env.ANTHROPIC_AUTH_TOKEN;
	}
	return env;
};

// W1 dispatch-side adoption (finding.w1): lanes ride the buckle front with a
// /w/<slug> prefix so usage attributes per lane (route_audit.lane). Opt-in
// per dispatch: only when the front answers and no hub redirect won.
export const BUCKLE_FRONT =
	process.env.SUSPENDERS_BUCKLE_FRONT ?? "http://127.0.0.1:4101";

export const probeBuckleFront = async (
	front = BUCKLE_FRONT,
): Promise<string | null> => {
	try {
		const r = await fetch(`${front}/status`, {
			signal: AbortSignal.timeout(600),
		});
		return r.ok ? front : null;
	} catch {
		return null;
	}
};

// The base-URL union (buckle laneEnv grammar, buckle/src/agents.ts): the
// anthropic root gets /w/<slug>; the openai-dialect bases add /v1.
export const applyLaneAttribution = (
	env: Record<string, string>,
	slug: string,
	front = BUCKLE_FRONT,
	key?: string,
): void => {
	const root = `${front}/w/${slug}`;
	env.ANTHROPIC_BASE_URL = root;
	env.OPENAI_BASE_URL = `${root}/v1`;
	env.OPENAI_API_BASE = `${root}/v1`;
	env.COPILOT_PROVIDER_BASE_URL = `${root}/v1`;
	env.GOOGLE_GEMINI_BASE_URL = root;
	// W918.3: the copilot executor rides the same front by BYOK (openai
	// wire, Bearer lane key) — one attribution, every executor's vars.
	if (key) {
		env.ANTHROPIC_AUTH_TOKEN = key;
		env.COPILOT_PROVIDER_API_KEY = key;
	}
};

// The tool-permission recipe is the CLAUDE spawn recipe — it lives in the
// claude adapter now; the local import feeds spawnClaude's default tail and
// the re-export keeps existing importers stable.
import { CLAUDE_ALLOWED_TOOLS } from "../../hooks/lib/executors/claude.ts";

export { CLAUDE_ALLOWED_TOOLS as DEFAULT_ALLOWED_TOOLS } from "../../hooks/lib/executors/claude.ts";

export const spawnClaude = (o: {
	bin: string;
	prompt: string;
	cwd: string;
	logFile: string;
	env: Record<string, string>;
	allowedTools?: string;
	/** The composed spawn tail — callers take it from the executor adapter
	 *  (hooks/lib/executors/registry.ts, W422); omitted = the claude recipe. */
	cliArgs?: string[];
	agent?: string;
	fleetDir?: string;
	/** W417.1: when set, the lane's W303 coord subscribe is attached at
	 * spawn level — idempotent pgrep per sid — so the WS inbox is live
	 * before the harness boots (codex/copilot lanes have no Claude hooks
	 * to open it from session-start). */
	sid?: string;
}) => {
	if (o.sid) attachSubscribe(o.sid);
	const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
	// W177 jobslab: nice + ulimit ceilings + env caps per lane class, before
	// the exec — a runaway lane dies at the rlimit instead of forkbombing
	// the user machine. Zero-cap classes (llm) keep the bare recipe.
	const js = jobslabFor(o.agent ?? "claude", o.fleetDir);
	const tail = (
		o.cliArgs ?? [
			"--allowedTools",
			o.allowedTools ?? CLAUDE_ALLOWED_TOOLS,
			"--permission-mode",
			"acceptEdits",
		]
	)
		.map((a) => (a.includes(" ") ? sq(a) : a))
		.join(" ");
	// A detached child has its own process group, so dispatcher group teardown
	// cannot terminate the harness. unref releases the event-loop reference.
	// exec preserves the recorded harness PID,
	// stdin EOF prevents input waits, and the log is the board's tail surface.
	return Bun.spawn(
		[
			"/bin/sh",
			"-c",
			`${jobslabPrefix(js)}${sq(o.bin)} -p ${sq(o.prompt)} ${tail} < /dev/null >> ${sq(o.logFile)} 2>&1`,
		],
		{
			detached: true,
			cwd: o.cwd,
			env: jobslabEnv(js, o.env),
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		},
	);
};
