// litellm-target.ts — the :4100 LiteLLM engine as an OWNED supervisor target
// (W277). Before this it ran under gateway.ts / com.belt.gateway, outside the
// supervisor: no backoff, no breaker, no status. That plist must stay unloaded
// now — the supervisor is the single restarter for :4100.
//
// Secrets are resolved at SPAWN time — the inherited env wins, else the
// machine-local key files (required Z.ai and LiteLLM; optional Anthropic,
// OpenAI, Copilot and OpenRouter). The Z.ai key source is the canonical
// private Fleet key file (regular, non-empty, mode 0600) — the unrelated
// ~/.config/zai tool config is NOT read here. litellm.yaml references them
// as os.environ/… so key values never appear in code, argv, logs or status.
//
// Liveness: GET /v1/models with the master key. 200 = serving + authorized,
// 401 = serving (endpoint alive, key mismatch); anything else = not serving.
//
// Preflight: `prisma` must import in the litellm uv tool env (the 2026-10-03
// root cause); native Prometheus metrics also require prometheus_client.
// Missing → log + alert status. Never auto-installed in-process.

import { openSync, readFileSync, statSync } from "node:fs";
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
	/** Canonical private Fleet Z.ai key file (regular file, non-empty, 0600). */
	zaiKeyFile: string;
	masterKeyFile: string;
	/** Anthropic upstream key for litellm.yaml rows pointing at
	 *  api.anthropic.com (claude-sonnet-5 / claude-haiku-4-5). Optional:
	 *  without it only the claude upstreams fail, the gateway still serves. */
	anthropicKeyFile: string;
	/** OpenAI API key for optional LiteLLM cloud rows. */
	openaiKeyFile: string;
	/** GitHub Copilot seat token (IKEA Copilot suite) for litellm.yaml rows
	 *  pointing at api.githubcopilot.com. Optional: without it only the
	 *  copilot upstreams fail, the gateway still serves. */
	copilotKeyFile: string;
	/** OpenRouter inference key, distinct from its management key. Optional:
	 * without it generated OpenRouter rows remain absent. */
	openrouterKeyFile: string;
	log: string;
}

export const DEFAULT_PATHS: LitellmPaths = {
	bin: `${HOME}/.local/bin/litellm`,
	python: `${HOME}/.local/share/uv/tools/litellm/bin/python`,
	config: `${HOME}/.claude/local-llm/litellm.yaml`,
	zaiKeyFile: `${HOME}/.claude/local-llm/zai.key`,
	masterKeyFile: `${HOME}/.claude/local-llm/litellm.key`,
	anthropicKeyFile: `${HOME}/.claude/local-llm/anthropic.key`,
	openaiKeyFile: `${HOME}/.claude/local-llm/openai.key`,
	copilotKeyFile: `${HOME}/.claude/local-llm/copilot.key`,
	openrouterKeyFile: `${HOME}/.claude/local-llm/openrouter.key`,
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
type StatFile = (path: string) => { isFile(): boolean; mode: number };

const readText: ReadFile = (path) => readFileSync(path, "utf8");

const tryRead = (read: ReadFile, path: string): string | null => {
	try {
		return read(path);
	} catch {
		return null;
	}
};

const tryStat = (stat: StatFile, path: string) => {
	try {
		return stat(path);
	} catch {
		return null;
	}
};

/** Canonical Z.ai source: a REGULAR, non-empty, 0600 key file. Anything
 *  else (absent, empty, wrong mode, directory/symlink) reads as no key —
 *  the failure then names the path, never a value. */
function zaiKeyFromFile(
	read: ReadFile,
	stat: StatFile,
	path: string,
): string | null {
	const st = tryStat(stat, path);
	if (!st?.isFile() || (st.mode & 0o777) !== 0o600) return null;
	const raw = tryRead(read, path);
	if (!raw) return null;
	const key = raw.trim();
	return key ? key : null;
}

/** Env first, then the 0600 files. Throws naming the SOURCE, never a value. */
export function loadKeys(
	paths: LitellmPaths = DEFAULT_PATHS,
	env: Env = process.env,
	read: ReadFile = readText,
	stat: StatFile = statSync,
): LitellmKeys {
	const zai = env.Z_AI_API_KEY || zaiKeyFromFile(read, stat, paths.zaiKeyFile);
	const master =
		env.LITELLM_KEY || tryRead(read, paths.masterKeyFile)?.trim() || null;
	const anthropic =
		env.ANTHROPIC_API_KEY ||
		tryRead(read, paths.anthropicKeyFile)?.trim() ||
		null;
	const openai =
		env.OPENAI_API_KEY || tryRead(read, paths.openaiKeyFile)?.trim() || null;
	const copilot =
		env.COPILOT_API_KEY || tryRead(read, paths.copilotKeyFile)?.trim() || null;
	const openrouter =
		env.OPENROUTER_API_KEY ||
		tryRead(read, paths.openrouterKeyFile)?.trim() ||
		null;
	const missing: string[] = [];
	if (!zai) missing.push(`Z_AI_API_KEY (env or ${paths.zaiKeyFile})`);
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
	/** Injected stat for the 0600 key-file gate (tests pin fixture paths). */
	stat?: StatFile;
	/** Override the server argv (tests run a stub on a free port). */
	argv?: string[];
	preflight?: () => string | null;
}

export function litellmTarget(deps: LitellmTargetDeps = {}): Target {
	const paths = deps.paths ?? DEFAULT_PATHS;
	const port = deps.port ?? LITELLM_PORT;
	const env = deps.env ?? process.env;
	const read = deps.read ?? readText;
	const stat = deps.stat ?? statSync;
	return {
		name: "litellm",
		port,
		kind: "gateway",
		owned: true,
		healthPath: "/v1/models",
		okStatus: LITELLM_OK_STATUS,
		probeHeaders: () => {
			try {
				const { LITELLM_KEY } = loadKeys(paths, env, read, stat);
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
			const keys = loadKeys(paths, env, read, stat);
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
