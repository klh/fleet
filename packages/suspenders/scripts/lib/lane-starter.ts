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
	applyLaneAttribution,
	laneEnv,
	probeBuckleFront,
} from "./lane.ts";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const STARTER_FLAG = "SUSPENDERS_LANE_STARTER";
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
};

export const starterEnabled = (env: Record<string, string | undefined>): boolean =>
	env[STARTER_FLAG] === "on" || env[STARTER_FLAG] === "1";

// The STABLE shared prefix. Repo-local protocol only — no sid, no item, no
// branch, no worktree path, no credentials (the credential guard below
// enforces it at seed time).
export const starterSeedPrompt = (): string =>
	[
		"You are a fleet lane executor for this repository. Orientation, stable across lanes:",
		"- Repo law: read AGENTS.md (root) and the nearest per-package AGENTS.md before any edit.",
		"- Quality: qlty is THE quality tool; .qlty/qlty.toml + biome rule set BEFORE the first write.",
		"- Never create/modify files via shell redirection; Edit/Write only.",
		"- 1500-line hard limit on any .ts; streams over buffers; config-over-code (no hardcoded hosts/keys).",
		"- UI: Lit web components + CSS design tokens; the UI law's forbidden DOM sinks are banned.",
		"- Progress: terse voice; evidence before claims; verify with real output.",
		"Acknowledge with READY and nothing else.",
	].join("\n");

// The per-lane identity APPENDED after the fork — everything lane-specific
// lives here, so the shared prefix stays cache-stable across lanes.
export const laneIdentityPrompt = (sid: string, wt: string): string =>
	`Lane ${sid} (fork of the orientation starter). Your worktree is ${wt}. Read ${wt}/.klh-brief.md (your readable worktree copy of the mission brief) and execute it fully.`;

// Secrets must never enter starter history: the seed is shared across every
// fork of its version, so one leaked token leaks into every lane.
export const assertNoSecrets = (text: string): void => {
	const hits = text.match(
		/sk-[A-Za-z0-9_-]{8,}|bksk_[A-Za-z0-9_-]{8,}|gho_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xoxb-|BEGIN (RSA|OPENSSH) PRIVATE KEY/,
	);
	if (hits) throw new Error(`starter seed refused — credential material detected: ${hits[0].slice(0, 8)}…`);
};

export const starterVersion = (seedPrompt: string): string =>
	createHash("sha256").update(seedPrompt).digest("hex").slice(0, 12);

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

/** Fork args per harness. claude is wired end-to-end; codex/copy rows are
 *  catalog-only until their spawn recipes compose (see module header). */
export const forkArgsFor = (
	harness: string,
	sessionId: string,
): string[] | null => {
	if (harness === "claude") return ["--resume", sessionId, "--fork-session"];
	return null;
};

// Bounded registry: keep the newest STARTER_REGISTRY_CAP records per fleet
// dir, delete the rest (retired versions are never resurrected).
const pruneRegistry = (fleet: string): void => {
	const dir = startersDir(fleet);
	if (!existsSync(dir)) return;
	const entries = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({
			f,
			createdAt: (JSON.parse(readFileSync(join(dir, f), "utf8")) as StarterRecord)
				.createdAt ?? 0,
		}))
		.sort((a, b) => b.createdAt - a.createdAt);
	for (const old of entries.slice(STARTER_REGISTRY_CAP)) {
		const stale = join(dir, old.f);
		if (existsSync(stale)) rmSync(stale);
	}
};

/** Seed a starter session ONCE per (harness, seed-prompt version) and persist
 *  its session id. The seed run is synchronous and short-lived: one turn,
 *  JSON output so the session id is parseable. Returns null when the harness
 *  has no fork support or the seed fails (dispatch falls back to cold start). */
export const ensureStarter = (
	fleet: string,
	harness: string,
	executorBin: string,
	env: Record<string, string>,
	options: {
		log?: (line: string) => void;
		timeoutMs?: number;
		run?: (bin: string, args: string[], env: Record<string, string>) => {
			code: number;
			out: string;
		};
	} = {},
): StarterFork | null => {
	const forkArgsOf = forkArgsFor(harness, "SEED");
	if (forkArgsOf === null) return null;
	const seed = starterSeedPrompt();
	assertNoSecrets(seed);
	const version = starterVersion(seed);
	const cached = readStarter(fleet, harness, version);
	if (cached) {
		return {
			harness,
			version,
			sessionId: cached.sessionId,
			forkArgs: forkArgsFor(harness, cached.sessionId) ?? [],
		};
	}
	const run = options.run ?? ((bin, args, e) => {
		const p = Bun.spawnSync([bin, ...args], {
			cwd: fleet,
			env: e,
			stdout: "pipe",
			stderr: "pipe",
			timeoutMs: options.timeoutMs ?? 180_000,
		});
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""} ${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`,
		};
	});
	const seedArgs = ["-p", seed, "--output-format", "json", "--max-turns", "1"];
	const res = run(executorBin, seedArgs, env);
	// Session-id presence is the success criterion, NOT the exit code: the CLI
	// can exit 1 on trailing diagnostics (observed live 2026-10-07: the
	// unrecognized_model line) while the session + usage are perfectly valid.
	const sessionId = parseSessionId(res.out);
	if (!sessionId) {
		options.log?.(
			`starter seed failed (${harness}, code ${res.code}): ${res.out.replaceAll("\n", " ").slice(0, 220)}`,
		);
		return null;
	}
	mkdirSync(startersDir(fleet), { recursive: true });
	const record: StarterRecord = {
		harness,
		version,
		sessionId,
		forkArgs: forkArgsFor(harness, sessionId) ?? [],
		createdAt: Date.now(),
		seedPromptSha: version,
	};
	writeFileSync(starterFile(fleet, harness, version), JSON.stringify(record), {
		mode: 0o600,
	});
	pruneRegistry(fleet);
	return record;
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
				if (typeof parsed.session_id === "string" && parsed.session_id.length > 0)
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
 *  Seed failure = cold-start fallback (surfaced in the dispatch log). */
export const dispatchStarterFork = async (o: {
	env: Record<string, string>;
	noBelt: boolean;
	harness: string;
	fleet: string;
	bin: string;
	item: string;
	sid: string;
	wt: string;
	coldPrompt: string;
	log: (line: string) => void;
	/** Test seam: forwarded to ensureStarter (run stub + log capture). */
	ensureOpts?: Parameters<typeof ensureStarter>[4];
}): Promise<{ forkArgs: string[]; prompt: string }> => {
	if (!starterEnabled(o.env) || o.harness !== "claude")
		return { forkArgs: [], prompt: o.coldPrompt };
	const seedEnv = laneEnv({ ...o.env }, o.noBelt);
	// Strip the per-lane identity so the seed never rides the lane key (the
	// attribution block in dispatch set ANTHROPIC_* for THIS lane only).
	for (const k of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"])
		delete seedEnv[k];
	if (!o.noBelt && (await probeBuckleFront()))
		applyLaneAttribution(seedEnv, "fleet-starter");
	const starter = ensureStarter(o.fleet, o.harness, o.bin, seedEnv, o.ensureOpts);
	if (!starter) {
		o.log(`STARTER ${o.item} — seed failed, cold start`);
		return { forkArgs: [], prompt: o.coldPrompt };
	}
	o.log(`STARTER ${o.item} — forked ${starter.version} (${starter.sessionId})`);
	return { forkArgs: starter.forkArgs, prompt: laneIdentityPrompt(o.sid, o.wt) };
};
