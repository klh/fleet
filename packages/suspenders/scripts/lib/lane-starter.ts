// scripts/lib/lane-starter.ts — W454 starter sessions + forked lane starts.
// A starter session is a ONE-TURN harness session holding the stable shared
// orientation prefix (repo law + fleet protocol, never per-lane data, never
// credentials). Lanes fork it instead of orienting from cold context:
//
//   claude   — seed once (`-p <seed> --output-format json` → session_id),
//              fork with `--resume <id> --fork-session` (binary-verified
//              flags on the installed 2.1.283 executor)
//   codex    — `exec resume <id>` chaining (resume verb + forked_from_id
//              thread fields verified in the 0.158 binary; wiring waits on
//              the spawn-recipe question — the recipe hardcodes `-p`)
//   copilot  — session fork/resume semantics UNVERIFIED (no local binary);
//              catalog row only, no fork args
//
// Versioning: the version IS the content — sha256 of the seed prompt. A
// starter session is bounded by construction: one seed turn, forks append
// to their OWN session (--fork-session leaves the original untouched).
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
// W422: fork support per harness is adapter data (exact lookup — an unknown
// harness cold-starts, it never inherits claude's fork grammar).
import { adapterForExact } from "../../hooks/lib/executors/registry.ts";
import { listStarters } from "../../hooks/lib/starter-artifacts.ts";
import { readStarterAuthorized } from "../../hooks/lib/starter-distribution.ts";
import {
	applyLaneAttribution,
	BUCKLE_FRONT,
	laneEnv,
	probeBuckleFront,
} from "./lane.ts";
import { runSeedGroup } from "./seed-group-run.ts";

export const STARTER_FLAG = "SUSPENDERS_LANE_STARTER";
/** W1124.12.2: the opt-in seed deadline. Firing it runs bounded process-group
 *  cancellation (seed-group-run.ts) — it does NOT by itself prove the seed's
 *  descendants died; only the verified group verdict does. */
export const STARTER_SEED_TIMEOUT_MS = 180_000;
// Registry cap — bounded history means bounded REGISTRY too: retired starter
// sessions are never reseeded, a new version supersedes them.
export const STARTER_REGISTRY_CAP = 8;

export type StarterFork = {
	harness: string;
	version: string;
	sessionId: string;
	/** Args to append to the harness CLI so the lane continues the starter
	 *  history as a NEW session (fork, not in-place resume). */
	forkArgs: string[];
};

export type StarterRecord = StarterFork & {
	createdAt: number;
	seedPromptSha: string;
	/** W818: one-time seed wall cost in ms — the start-observability line
	 *  reports it so a fork's "saved" figure has a paid-once anchor. Absent on
	 *  records written before W818. */
	seedMs?: number;
};

// W695.1: a seed failure is DATA, not a dropped one-liner — exit code,
// bounded stderr tail, phase marker, and the belt-front preflight verdict
// travel into dispatch output and the lane registry row, so a cold-start
// fallback is explainable from the dispatch log alone.
export type StarterSeedFailure = {
	/** Which phase produced the failure. */
	phase: "starter-seed";
	/** The seed run's exit code. */
	code: number;
	/** Bounded, newline-flattened tail of the seed run's stderr. */
	stderrTail: string;
	/** Verdict of the belt-front health probe taken BEFORE the seed ran
	 *  (undefined when the probe was skipped — --no-belt). */
	preflight?: string;
	/** W1124.12.2: the deadline fired and bounded process-group cancellation
	 *  ran (seed-group-run.ts). Never a termination claim by itself. */
	timedOut?: boolean;
	/** W1124.12.2: verified AFTER cancellation — no live member of the seed's
	 *  process group remained (kill(-pgid, 0) → ESRCH). */
	verifiedDown?: boolean;
	/** W1124.12.2: cancellation ran but bounded cleanup could NOT verify the
	 *  group dead — live descendants may remain. */
	survivors?: boolean;
};

export type StarterSeedOutcome =
	| {
			kind: "fork";
			/** W818: whether the fork reuses a registry record or this call seeded. */
			source: "cached" | "seeded";
			fork: StarterFork;
			/** One-time seed wall cost in ms (source=seeded only). */
			seedMs?: number;
	  }
	| { kind: "failure"; failure: StarterSeedFailure };

// W818 observability: the per-fork "saved" figure dispatch reports is the
// W768 adoption bench median delta (docs/lane-starters.md, 2026-10-15) —
// cold 76.6 s vs fork 16.3 s wall per lane. A doc-sourced estimate, not a
// live per-lane measurement.
export const STARTER_SAVED_S = 60.3;

// W818: what a lane start actually did, structured so dispatch output and
// the lane log render the same line — fork (source + saved seconds) or
// cold start + reason.
export type StarterStartOutcome =
	| {
			mode: "fork";
			/** Where the fork came from: the registry record or this call's seed. */
			source: "cached" | "seeded";
			version: string;
			session: string;
			/** One-time seed wall cost in ms (source=seeded only). */
			seedMs?: number;
			savedS: number;
	  }
	| { mode: "cold"; reason: string };

export const starterStartLine = (
	item: string,
	s: StarterStartOutcome,
): string =>
	s.mode === "fork"
		? `STARTER ${item} — forked starter ${s.version} (${s.source}, session ${s.session}${s.seedMs === undefined ? "" : `, seed ${Math.round(s.seedMs / 1000)}s`}; saved ≈${s.savedS}s vs cold, W768 bench)`
		: `STARTER ${item} — cold start (${s.reason})`;

/** Bounded, newline-flattened tail — the shape dispatch output and the
 *  registry row carry. Tail (not head): the CLI's final diagnostics are the
 *  verdict; the early chatter is noise. */
export const flattenTail = (s: string, cap = 220): string => {
	const flat = s.replaceAll(/\s+/g, " ").trim();
	return flat.length <= cap ? flat : `…${flat.slice(-cap + 1)}`;
};

export const starterEnabled = (
	env: Record<string, string | undefined>,
): boolean => {
	// W1124.12.1: default OFF — a stalled seed turn (the timeout knob was
	// silently ignored, six warm seeds hung for hours) must never wedge a
	// dispatch. Operators opt IN explicitly ("on"/"1"); "off"/"0" stays off.
	const v = env[STARTER_FLAG];
	return v === "on" || v === "1";
};

// The STABLE shared prefix. Repo-local protocol only — no sid, no item, no
// branch, no worktree path, no credentials (the credential guard below
// enforces it at seed time).
export const starterInstructionContext = (guidance?: string): string => {
	const base = [
		"You are a fleet lane executor for this repository. Orientation, stable across lanes:",
		"- Repo law: read AGENTS.md (root) and the nearest per-package AGENTS.md before any edit.",
		"- Quality: qlty is THE quality tool; .qlty/qlty.toml + biome rule set BEFORE the first write.",
		"- Never create/modify files via shell redirection; Edit/Write only.",
		"- 1500-line hard limit on any .ts; streams over buffers; config-over-code (no hardcoded hosts/keys).",
		"- UI: Lit web components + CSS design tokens; the UI law's forbidden DOM sinks are banned.",
		"- Progress: terse voice; evidence before claims; verify with real output.",
	];
	if (guidance) {
		base.push("Promoted lane guidance:");
		base.push(guidance);
	}
	return base.join("\n");
};

export const starterSeedPrompt = (fleet?: string, model?: string): string => {
	let guidance: string | undefined;
	if (fleet) {
		try {
			const repo = dirname(fleet);
			const versions = listStarters(repo, "lane-orientation").sort(
				(a, b) => b.version - a.version,
			);
			for (const row of versions) {
				const read = readStarterAuthorized(
					repo,
					"lane-orientation",
					row.version,
				);
				if (!read.ok) continue;
				if (!read.artifact.compatibility.harnesses.includes("claude")) continue;
				if (
					model &&
					!read.artifact.compatibility.models.includes(model) &&
					!read.artifact.compatibility.models.includes("*")
				)
					continue;
				guidance = read.artifact.instructions;
				break;
			}
		} catch {
			// A damaged registry cannot prevent lanes from starting. Fall back
			// to the fixed, reviewed orientation prompt.
		}
	}
	return `${starterInstructionContext(guidance)}\nAcknowledge with READY and nothing else.`;
};

// The per-lane identity APPENDED after the fork — everything lane-specific
// lives here, so the shared prefix stays cache-stable across lanes.
export const laneIdentityPrompt = (sid: string, wt: string): string =>
	`Lane ${sid} (fork of the orientation starter). Your worktree is ${wt}. Read ${wt}/.klh-brief.md (your readable worktree copy of the mission brief) and execute it fully.`;

// Secrets must never enter starter history: the seed is shared across every
// fork of its version, so one leaked token leaks into every lane. The guard
// lives in hooks/lib/secret-guard.ts (W458.1) — one pattern shared with the
// starter-artifact validation.
import { assertNoSecrets } from "../../hooks/lib/secret-guard.ts";
import { WORKER_MANAGED_PROFILE } from "../../hooks/lib/executors/claude.ts";

export { assertNoSecrets };

export const starterVersion = (seedPrompt: string): string =>
	createHash("sha256")
		.update(
			// W1124.12: the managed worker profile is part of a starter's
			// identity — a profile change supersedes every cached session.
			`${WORKER_MANAGED_PROFILE.mcpConfig}|${WORKER_MANAGED_PROFILE.tools}|${seedPrompt}`,
		)
		.digest("hex")
		.slice(0, 12);

export const startersDir = (fleet: string): string => join(fleet, "starters");

const starterFile = (fleet: string, harness: string, version: string): string =>
	join(startersDir(fleet), `${harness}-${version}.json`);

export const readStarter = (
	fleet: string,
	harness: string,
	version: string,
): StarterRecord | null => {
	const f = starterFile(fleet, harness, version);
	if (!existsSync(f)) return null;
	try {
		return JSON.parse(readFileSync(f, "utf8")) as StarterRecord;
	} catch {
		return null;
	}
};

/** Fork args per harness — the W422 executor-adapter registry owns the
 *  grammar now (claude row carries ["--resume", id, "--fork-session"];
 *  codex/copilot/grok/cline rows are catalog-only → cold start). Exact
 *  lookup only: an unknown harness must cold-start, never fork like claude. */
export const forkArgsFor = (
	harness: string,
	sessionId: string,
): string[] | null => adapterForExact(harness)?.forkArgs(sessionId) ?? null;

// Bounded registry: keep the newest STARTER_REGISTRY_CAP records per fleet
// dir, delete the rest (retired versions are never resurrected).
const pruneRegistry = (fleet: string): void => {
	const dir = startersDir(fleet);
	if (!existsSync(dir)) return;
	const entries = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({
			f,
			createdAt:
				(JSON.parse(readFileSync(join(dir, f), "utf8")) as StarterRecord)
					.createdAt ?? 0,
		}))
		.sort((a, b) => b.createdAt - a.createdAt);
	for (const old of entries.slice(STARTER_REGISTRY_CAP)) {
		const stale = join(dir, old.f);
		if (existsSync(stale)) rmSync(stale);
	}
};

/** Seed a starter session ONCE per (harness, seed-prompt version) and persist
 *  its session id. The seed run is one turn, one JSON result. Returns null
 *  when the harness has no fork support (cold start, nothing attempted); a
 *  FAILED seed attempt returns the failure record instead of a fork. */
export const ensureStarter = async (
	fleet: string,
	harness: string,
	executorBin: string,
	env: Record<string, string>,
	options: {
		model?: string;
		log?: (line: string) => void;
		timeoutMs?: number;
		/** Test seam: sync stubs stay supported; the default is the W1124.12.2
		 *  bounded process-group runner (seed-group-run.ts). */
		run?: (
			bin: string,
			args: string[],
			env: Record<string, string>,
		) =>
			| {
					code: number;
					out: string;
					err?: string;
			  }
			| Promise<{
					code: number | null;
					out: string;
					err?: string;
					timedOut?: boolean;
					verifiedDown?: boolean | null;
					survivors?: boolean;
			  }>;
	} = {},
): Promise<StarterSeedOutcome | null> => {
	const forkArgsOf = forkArgsFor(harness, "SEED");
	if (forkArgsOf === null) return null;
	// W918.3: the seed TURN grammar is adapter data too — a harness with
	// fork args but no verified seed recipe (copilot: claude-grammar seed
	// flags die on its CLI) cold-starts; fork grammar ≠ seed grammar.
	const seedArgsOf = adapterForExact(harness)?.starterSeedArgs;
	if (!seedArgsOf) return null;
	const seed = starterSeedPrompt(fleet, options.model);
	assertNoSecrets(seed);
	const version = starterVersion(seed);
	const cached = readStarter(fleet, harness, version);
	if (cached) {
		return {
			kind: "fork",
			source: "cached",
			fork: {
				harness,
				version,
				sessionId: cached.sessionId,
				forkArgs: forkArgsFor(harness, cached.sessionId) ?? [],
			},
		};
	}
	// W1124.12.2: the default seed ride is runSeedGroup — the child leads its
	// own POSIX process group; the deadline cancels the WHOLE group (SIGTERM
	// → grace → SIGKILL) with a verified group-down verdict. A spawnSync
	// `timeout` SIGTERMs the direct child only and can never prove the tree
	// terminated (killTree is absent from the installed API) — retired here.
	const run =
		options.run ??
		((bin, args, e) =>
			runSeedGroup(bin, args, {
				cwd: fleet,
				env: e,
				timeoutMs: options.timeoutMs ?? STARTER_SEED_TIMEOUT_MS,
			}));
	const seedArgs = seedArgsOf(seed);
	const seedStartedAt = Date.now();
	const res = await run(executorBin, seedArgs, env);
	const seedMs = Date.now() - seedStartedAt;
	const timedOut = res.timedOut === true;
	const verifiedDown = res.verifiedDown === true;
	const survivors = res.survivors === true;
	// Session-id presence is the success criterion, NOT the exit code: the CLI
	// can exit 1 on trailing diagnostics (observed live 2026-10-07: the
	// unrecognized_model line) while the session + usage are perfectly valid.
	const sessionId = parseSessionId(`${res.out} ${res.err ?? ""}`);
	if (!sessionId) {
		const failure: StarterSeedFailure = {
			phase: "starter-seed",
			// signal-cancelled seeds never exited — the spawnSync shape also
			// degraded a null exit code to 1
			code: res.code ?? 1,
			stderrTail: flattenTail(res.err || res.out),
		};
		if (timedOut) {
			failure.timedOut = true;
			failure.verifiedDown = verifiedDown;
			failure.survivors = survivors;
		}
		options.log?.(
			`starter seed failed (${harness}, phase ${failure.phase}, code ${failure.code}${timedOut ? `, timed out, ${survivors ? `survivors possible (verifiedDown=${verifiedDown})` : "group verified down"}` : ""}): ${failure.stderrTail}`,
		);
		return { kind: "failure", failure };
	}
	mkdirSync(startersDir(fleet), { recursive: true });
	const record: StarterRecord = {
		harness,
		version,
		sessionId,
		forkArgs: forkArgsFor(harness, sessionId) ?? [],
		createdAt: Date.now(),
		seedPromptSha: version,
		seedMs,
	};
	writeFileSync(starterFile(fleet, harness, version), JSON.stringify(record), {
		mode: 0o600,
	});
	pruneRegistry(fleet);
	return { kind: "fork", source: "seeded", seedMs, fork: record };
};

/** Pull the session id out of a `--output-format json` result. Tolerant of
 *  leading/trailing non-JSON text (the CLI can append diagnostics after the
 *  result object — same live finding as the bench parser): walk candidate
 *  object windows and accept the first parse with a string session id. */
export const parseSessionId = (out: string): string | null => {
	for (
		let start = out.indexOf("{");
		start >= 0;
		start = out.indexOf("{", start + 1)
	) {
		for (
			let end = out.lastIndexOf("}");
			end > start;
			end = out.lastIndexOf("}", end - 1)
		) {
			try {
				const parsed = JSON.parse(out.slice(start, end + 1)) as {
					session_id?: unknown;
				};
				if (
					typeof parsed.session_id === "string" &&
					parsed.session_id.length > 0
				)
					return parsed.session_id;
			} catch {
				// try the next (shorter) window
			}
		}
	}
	return null;
};

/** Dispatch-facing wiring (W454): when the starter flag is on and the
 *  harness supports forking, resolve a starter session (seed once per
 *  version) and return fork args + lane prompt. The SEED rides a fleet
 *  identity (fleet-starter attribution slug), never the lane's minted key:
 *  the lane's ANTHROPIC_AUTH_TOKEN/BASE_URL are stripped from the seed env.
 *  Seed failure = cold-start fallback + a structured seedError (exit code,
 *  stderr tail, phase marker, belt-front preflight verdict) on the result. */
export const dispatchStarterFork = async (o: {
	env: Record<string, string>;
	noBelt: boolean;
	harness: string;
	fleet: string;
	bin: string;
	model?: string;
	item: string;
	sid: string;
	wt: string;
	coldPrompt: string;
	log: (line: string) => void;
	/** Test seam: forwarded to ensureStarter (run stub + log capture). */
	ensureOpts?: Parameters<typeof ensureStarter>[4];
	/** W695.1 test seam: the preflight probe (default: the W454 buckle-front
	 *  probe). Injecting `async () => null` pins the "belt-front down" verdict. */
	probe?: () => Promise<string | null>;
}): Promise<{
	forkArgs: string[];
	prompt: string;
	seedError?: StarterSeedFailure;
	/** W818: the structured start outcome — dispatch output and the lane log
	 *  render it via starterStartLine. */
	starter?: StarterStartOutcome;
}> => {
	const coldStart = (
		reason: string,
	): {
		forkArgs: string[];
		prompt: string;
		starter: StarterStartOutcome;
	} => ({
		forkArgs: [],
		prompt: o.coldPrompt,
		starter: { mode: "cold", reason },
	});
	if (!starterEnabled(o.env))
		return coldStart(`${STARTER_FLAG}=${o.env[STARTER_FLAG]}`);
	if (o.harness !== "claude")
		return coldStart(`no fork adapter for ${o.harness}`);
	const seedEnv = laneEnv({ ...o.env }, o.noBelt);
	// Strip the per-lane identity so the seed never rides the lane key (the
	// attribution block in dispatch set ANTHROPIC_* for THIS lane only).
	for (const k of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"])
		delete seedEnv[k];
	// W695.1: the belt-front probe reused as SEED PREFLIGHT — its verdict
	// rides every seed failure (a seed is a belt-shaped HTTP call; a down
	// front is the first suspect). One probe answers both attribution and
	// the failure marker.
	const front = o.noBelt ? null : await (o.probe ?? probeBuckleFront)();
	const preflight = o.noBelt
		? undefined
		: front
			? `belt-front up: ${front}`
			: `belt-front down: ${BUCKLE_FRONT} did not answer /status`;
	if (front) applyLaneAttribution(seedEnv, "fleet-starter", front);
	const starter = await ensureStarter(o.fleet, o.harness, o.bin, seedEnv, {
		...o.ensureOpts,
		model: o.model,
	});
	if (starter?.kind === "fork") {
		const outcome: StarterStartOutcome = {
			mode: "fork",
			source: starter.source,
			version: starter.fork.version,
			session: starter.fork.sessionId,
			...(starter.seedMs === undefined ? {} : { seedMs: starter.seedMs }),
			savedS: STARTER_SAVED_S,
		};
		o.log(starterStartLine(o.item, outcome));
		return {
			forkArgs: starter.fork.forkArgs,
			prompt: laneIdentityPrompt(o.sid, o.wt),
			starter: outcome,
		};
	}
	if (!starter) {
		const outcome: StarterStartOutcome = {
			mode: "cold",
			reason: `no fork adapter for ${o.harness}`,
		};
		o.log(starterStartLine(o.item, outcome));
		return { forkArgs: [], prompt: o.coldPrompt, starter: outcome };
	}
	const seedError: StarterSeedFailure = preflight
		? { ...starter.failure, preflight }
		: starter.failure;
	o.log(
		`STARTER ${o.item} — seed failed (${seedError.phase}, code ${seedError.code}${preflight ? `, ${preflight}` : ""}): ${seedError.stderrTail}`,
	);
	return {
		forkArgs: [],
		prompt: o.coldPrompt,
		seedError,
		starter: { mode: "cold", reason: "starter seed failed" },
	};
};
