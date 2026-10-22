// litellm-target.ts — the :4100 LiteLLM engine as an OWNED supervisor target
// (W277). Before this it ran under gateway.ts / com.belt.gateway, outside the
// supervisor: no backoff, no breaker, no status. That plist must stay unloaded
// now — the supervisor is the single restarter for :4100.
//
// Secrets are resolved at SPAWN time — the inherited env wins, else the
// machine-local key files (required Z.ai and LiteLLM; optional Anthropic,
// OpenAI, Copilot and OpenRouter). litellm.yaml references them as
// os.environ/… so key values never appear in code, argv, logs or status.
//
// Liveness: GET /v1/models with the master key. 200 = serving + authorized,
// 401 = serving (endpoint alive, key mismatch); anything else = not serving.
//
// Preflight: `prisma` must import in the litellm uv tool env (the 2026-10-03
// root cause); native Prometheus metrics also require prometheus_client.
// Missing → log + alert status. Never auto-installed in-process.

import { openSync, readFileSync } from "node:fs";
import {
	type ProviderEntry,
	loadProviderProfiles,
	profileForEnv,
} from "./provider-profiles.ts";
import type { Child, Target } from "./supervisor.ts";

const HOME = process.env.HOME ?? "";

export const LITELLM_PORT = 4100;
export const LITELLM_OK_STATUS = [200, 401];
export const LITELLM_TOOL_SPEC = "litellm[proxy]==1.103.0";
export const LITELLM_PRISMA_SPEC = "prisma==0.15.0";
export const LITELLM_PROMETHEUS_SPEC = "prometheus-client==0.20.0";

/** Reproducible tool environment for first install and dependency repair. */
export const litellmToolInstallArgs = (uv = "uv"): string[] => [
	uv,
	"tool",
	"install",
	"--force",
	"--python",
	"3.13",
	"--with",
	LITELLM_PRISMA_SPEC,
	"--with",
	LITELLM_PROMETHEUS_SPEC,
	LITELLM_TOOL_SPEC,
];

export interface LitellmPaths {
	bin: string;
	python: string;
	config: string;
	masterKeyFile: string;
	/** W1124.8.4: the private stack.yaml carrying the central provider
	 *  profiles (mode 600). Provider keys (Z_AI_API_KEY, ANTHROPIC_API_KEY,
	 *  OPENAI_API_KEY, COPILOT_API_KEY, OPENROUTER_API_KEY) resolve env
	 *  first, then the profile whose OUTPUT binding names the env var.
	 *  KLH_STACK overrides like the speedy loader. */
	stackConfig: string;
	log: string;
}

export const DEFAULT_PATHS: LitellmPaths = {
	bin: `${HOME}/.local/bin/litellm`,
	python: `${HOME}/.local/share/uv/tools/litellm/bin/python`,
	config: `${HOME}/.claude/local-llm/litellm.yaml`,
	masterKeyFile: `${HOME}/.claude/local-llm/litellm.key`,
	stackConfig: process.env.KLH_STACK ?? `${HOME}/.config/klh/stack.yaml`,
	log: `${HOME}/.claude/local-llm/litellm-gateway.log`,
};

export interface LitellmKeys {
	Z_AI_API_KEY: string;
	LITELLM_KEY: string;
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
	COPILOT_API_KEY?: string;
	OPENROUTER_API_KEY?: string;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const readText: ReadFile = (path) => readFileSync(path, "utf8");

const tryRead = (read: ReadFile, path: string): string | null => {
	try {
		return read(path);
	} catch {
		return null;
	}
};

/** W1124.8.4: resolve one provider profile by its OUTPUT env binding —
 *  the central stack.yaml value rides the inherited env or the resolved
 *  profile (never a key-file convention). A present env value wins (the
 *  spawn-time override path); an unreadable/malformed stack or a profile
 *  without this binding returns null — optional legs degrade, the
 *  REQUIRED legs throw naming the source. */
const fromProfileEnv = (
	envName: string,
	env: Env,
	stackPath: string,
	read: ReadFile,
): string | null => {
	if (env[envName]) return env[envName] as string;
	let profiles: Record<string, ProviderEntry>;
	try {
		profiles = loadProviderProfiles(stackPath, read);
	} catch {
		return null;
	}
	const resolved = profileForEnv(envName, profiles);
	return resolved?.key ?? null;
};

/** Central profiles first, then the zai legacy 0600 config for the
 *  required leg. Throws naming the SOURCE, never a value. */
export function loadKeys(
	paths: LitellmPaths = DEFAULT_PATHS,
	env: Env = process.env,
	read: ReadFile = readText,
): LitellmKeys {
	const master =
		env.LITELLM_KEY || tryRead(read, paths.masterKeyFile)?.trim() || null;
	const profileKey = (envName: string): string | null =>
		fromProfileEnv(envName, env, paths.stackConfig, read);
	const zai = profileKey("Z_AI_API_KEY");
	const anthropic = profileKey("ANTHROPIC_API_KEY");
	const openai = profileKey("OPENAI_API_KEY");
	const copilot = profileKey("COPILOT_API_KEY");
	const openrouter = profileKey("OPENROUTER_API_KEY");
	const missing: string[] = [];
	if (!zai)
		missing.push(
			`Z_AI_API_KEY (env or a provider profile in ${paths.stackConfig} with env binding Z_AI_API_KEY)`,
		);
	if (!master) missing.push(`LITELLM_KEY (env or ${paths.masterKeyFile})`);
	if (!zai || !master) throw new Error(`missing ${missing.join(", ")}`);
	return {
		Z_AI_API_KEY: zai,
		LITELLM_KEY: master,
		...(anthropic ? { ANTHROPIC_API_KEY: anthropic } : {}),
		...(openai ? { OPENAI_API_KEY: openai } : {}),
		...(copilot ? { COPILOT_API_KEY: copilot } : {}),
		...(openrouter ? { OPENROUTER_API_KEY: openrouter } : {}),
	};
}

export const litellmArgv = (
	paths: LitellmPaths = DEFAULT_PATHS,
	port = LITELLM_PORT,
): string[] => [
	// --host pins the engine to loopback: buckle :4101 fronts it; a LAN
	// bind (*) turned :4100 into a side entrance past the gate (2026-10-06).
	paths.bin,
	"--host",
	"127.0.0.1",
	"--config",
	paths.config,
	"--port",
	String(port),
];

/** null = prisma importable; otherwise the alert reason. */
export function prismaPreflight(python = DEFAULT_PATHS.python): string | null {
	const fix = `fix: ${litellmToolInstallArgs().join(" ")}`;
	try {
		const r = Bun.spawnSync([python, "-c", "import prisma"], {
			stdout: "ignore",
			stderr: "pipe",
		});
		if (r.exitCode === 0) return null;
		const tail = r.stderr.toString().trim().split("\n").pop() ?? "";
		return `prisma not importable in litellm tool env (${tail}) — ${fix}`;
	} catch (e) {
		return `litellm tool python unusable at ${python} (${String(e)}) — ${fix}`;
	}
}

/** null = native Prometheus collector importable in the LiteLLM tool env. */
export function prometheusPreflight(
	python = DEFAULT_PATHS.python,
): string | null {
	const fix = `fix: ${litellmToolInstallArgs().join(" ")}`;
	try {
		const r = Bun.spawnSync([python, "-c", "import prometheus_client"], {
			stdout: "ignore",
			stderr: "pipe",
		});
		if (r.exitCode === 0) return null;
		const tail = r.stderr.toString().trim().split("\n").pop() ?? "";
		return `prometheus_client not importable in litellm tool env (${tail}) — ${fix}`;
	} catch (e) {
		return `litellm tool python unusable at ${python} (${String(e)}) — ${fix}`;
	}
}

export interface LitellmTargetDeps {
	paths?: LitellmPaths;
	port?: number;
	env?: Env;
	read?: ReadFile;
	/** Override the server argv (tests run a stub on a free port). */
	argv?: string[];
	preflight?: () => string | null;
}

export function litellmTarget(deps: LitellmTargetDeps = {}): Target {
	const paths = deps.paths ?? DEFAULT_PATHS;
	const port = deps.port ?? LITELLM_PORT;
	const env = deps.env ?? process.env;
	const read = deps.read ?? readText;
	return {
		name: "litellm",
		port,
		kind: "gateway",
		owned: true,
		healthPath: "/v1/models",
		okStatus: LITELLM_OK_STATUS,
		probeHeaders: () => {
			try {
				const { LITELLM_KEY } = loadKeys(paths, env, read);
				return { Authorization: `Bearer ${LITELLM_KEY}` };
			} catch {
				return {}; // unauthenticated probe: 401 still proves liveness
			}
		},
		// litellm can wedge with the port bound — restart after hungThreshold.
		killHung: true,
		bindTimeoutMs: 120_000,
		preflight:
			deps.preflight ??
			(() =>
				prismaPreflight(paths.python) ?? prometheusPreflight(paths.python)),
		spawn: (): Child => {
			const keys = loadKeys(paths, env, read);
			const fd = openSync(paths.log, "a");
			return Bun.spawn(deps.argv ?? litellmArgv(paths, port), {
				stdin: "ignore",
				stdout: fd,
				stderr: fd,
				env: { ...env, ...keys },
			});
		},
	};
}
