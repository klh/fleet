// hooks/lib/buckle-spoke-health.ts — W1278.2: detect and recover a Buckle
// spoke startup failure. The 2026-10-25 incident: com.suspenders
// .buckle-spoke crash-looped (729 launchd failed runs, :4101 ECONNREFUSED)
// for hours because BUCKLE_UPSTREAMS named a retired upstreams.yaml while
// upstreams.json existed — and nothing watched for it. The board's
// recovery-map entry (buckle-4101) only RENDERS commands; this module is the
// outside-process probe (health is outside-process law) + the guarded
// repair the monitor runs under --fix.
//
// Guards (owner law, 2026-10-25 incident note): preserve active keys/config
// — the repair rewrites ONLY the BUCKLE_UPSTREAMS line, suffix-only, and
// never touches a healthy spoke; recovery holds under .fleet/reclaim-paused.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { automaticRecoveryPaused } from "./automatic-recovery.ts";

export const BUCKLE_SPOKE_LABEL = "com.suspenders.buckle-spoke";
export const BUCKLE_SPOKE_PORT = 4101;
export const SPOKE_LOG_PATH = "~/.claude-insights/buckle-spoke.log";
export const SPOKE_ENV_FILES = [
	"~/.claude/local-llm/belt.env",
	"~/.claude/local-llm/buckle-spoke.env",
];

// the exact refusal buckle prints when BUCKLE_UPSTREAMS names an absent file
// (packages/buckle/src/upstreams.ts, W1123)
const FAILURE_RE = /BUCKLE_UPSTREAMS=(\S+) is configured but missing/;
const LOG_TAIL_BYTES = 65_536;

export type SpokeState = "healthy" | "startup-failure" | "down";

export interface SpokeHealth {
	state: SpokeState;
	detail: string;
	// the upstreams path the spoke refused to boot without (startup-failure)
	configured?: string;
}

export interface SpokeDeps {
	home: string;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	readText: (path: string) => string | null;
	exists: (path: string) => boolean;
	writeFile: (path: string, content: string) => void;
	kickstart: (label: string) => Promise<number>;
}

export const expandTilde = (home: string, p: string): string =>
	p.startsWith("~/") ? joinPath(home, p.slice(2)) : p;

// path join without importing node:path — keeps the pure helpers testable
// against "~/..." forms and Windows-free
const joinPath = (home: string, rest: string): string =>
	home.endsWith("/") ? `${home}${rest}` : `${home}/${rest}`;

// pure classifier: the log tail → the misconfiguration, or null. Honors the
// LAST match (restarts append; the newest refusal is the live one).
export const startupFailureFromLog = (
	tail: string,
): { configured: string } | null => {
	const matches = [...tail.matchAll(new RegExp(FAILURE_RE.source, "g"))];
	const last = matches.at(-1);
	return last ? { configured: last[1] } : null;
};

// bounded tail read — a size-capped buffer, per the streams-over-buffers law
export const tailOf = (content: string | null, maxBytes: number): string =>
	content === null ? "" : content.slice(-maxBytes);

export const realSpokeDeps = (home: string): SpokeDeps => ({
	home,
	fetch: (url, init) => fetch(url, init),
	readText: (path) => {
		try {
			return readFileSync(expandTilde(home, path), "utf8");
		} catch {
			return null;
		}
	},
	exists: (path) => existsSync(expandTilde(home, path)),
	writeFile: (path, content) => {
		const full = expandTilde(home, path);
		let mode: number | undefined;
		try {
			mode = statSync(full).mode;
		} catch {} // new file — default mode
		writeFileSync(full, content, { mode });
	},
	kickstart: (label) =>
		new Promise((resolve) => {
			const uid = typeof process.getuid === "function" ? process.getuid() : 0;
			const p = Bun.spawn(
				["launchctl", "kickstart", "-k", `gui/${uid}/${label}`],
				{ stdout: "pipe", stderr: "pipe" },
			);
			void p.exited.then(resolve);
		}),
});

// outside-process probe: only the network answer counts (a spoke cannot
// paint itself healthy). 2xx on /status = up.
export const probeSpoke = async (deps: SpokeDeps): Promise<boolean> => {
	try {
		const r = await deps.fetch(`http://127.0.0.1:${BUCKLE_SPOKE_PORT}/status`, {
			signal: AbortSignal.timeout(1500),
		});
		return r.ok;
	} catch {
		return false;
	}
};

export const buckleSpokeHealth = async (
	deps: SpokeDeps,
): Promise<SpokeHealth> => {
	if (await probeSpoke(deps))
		return { state: "healthy", detail: ":4101 answering" };
	const failure = startupFailureFromLog(
		tailOf(deps.readText(SPOKE_LOG_PATH), LOG_TAIL_BYTES),
	);
	if (failure)
		return {
			state: "startup-failure",
			detail: `BUCKLE_UPSTREAMS=${failure.configured} is configured but missing`,
			configured: failure.configured,
		};
	return { state: "down", detail: ":4101 not answering" };
};

export type RecoveryOutcome =
	| { status: "recovered"; detail: string }
	| { status: "skip-healthy"; detail: string }
	| { status: "hold-paused"; detail: string }
	| { status: "unrecoverable"; detail: string }
	| { status: "stale-pointer"; detail: string }
	| { status: "failed"; detail: string };

// the guarded repair. Refuses everything but the exact recoverable shape:
// probe dark + log names a MISSING .yaml + the sibling .json exists. The
// repoint rewrites only the BUCKLE_UPSTREAMS line in the spoke's env files
// (keys and every other line preserved byte-for-byte), then kickstarts the
// launchd agent once.
export const recoverBuckleSpoke = async (
	deps: SpokeDeps,
	repo: string,
): Promise<RecoveryOutcome> => {
	const health = await buckleSpokeHealth(deps);
	if (health.state === "healthy")
		return { status: "skip-healthy", detail: health.detail };
	if (automaticRecoveryPaused(repo))
		return { status: "hold-paused", detail: health.detail };
	if (health.state !== "startup-failure" || !health.configured)
		return { status: "unrecoverable", detail: health.detail };
	const configured = health.configured;
	if (!configured.endsWith(".yaml"))
		return {
			status: "unrecoverable",
			detail: `configured path is not a retired .yaml name: ${configured}`,
		};
	const jsonPath = `${configured.slice(0, -5)}.json`;
	if (deps.exists(configured) || !deps.exists(jsonPath))
		return {
			status: "unrecoverable",
			detail: `expected ${configured} absent + ${jsonPath} present; machine state moved on`,
		};
	const repointed: string[] = [];
	for (const envFile of SPOKE_ENV_FILES) {
		const content = deps.readText(envFile);
		if (content === null) continue;
		const m = content.match(/^BUCKLE_UPSTREAMS=(.*)$/m);
		if (!m) continue;
		const value = m[1].trim();
		if (expandTilde(deps.home, value) !== expandTilde(deps.home, configured))
			continue;
		deps.writeFile(
			envFile,
			content.replace(m[0], `BUCKLE_UPSTREAMS=${jsonPath}`),
		);
		repointed.push(envFile);
	}
	if (repointed.length === 0)
		return {
			status: "stale-pointer",
			detail: `no env file still names ${configured} — the pointer moved; read ${SPOKE_LOG_PATH}`,
		};
	const code = await deps.kickstart(BUCKLE_SPOKE_LABEL);
	if (code !== 0)
		return {
			status: "failed",
			detail: `repointed ${repointed.join(", ")} but launchctl kickstart exited ${code}`,
		};
	return {
		status: "recovered",
		detail: `repointed BUCKLE_UPSTREAMS → ${jsonPath} in ${repointed.join(", ")} and kickstarted ${BUCKLE_SPOKE_LABEL}`,
	};
};

// the monitor entry: detect (read-only pass) + recover (--fix). Issues when
// the spoke is not healthy; fixed lines only for a landed repair.
export const checkBuckleSpoke = async (
	opts: { fix: boolean; home: string; repo: string },
	deps: SpokeDeps = realSpokeDeps(opts.home),
): Promise<{ issues: string[]; fixed: string[] }> => {
	const health = await buckleSpokeHealth(deps);
	if (health.state === "healthy") return { issues: [], fixed: [] };
	const label =
		health.state === "startup-failure"
			? `buckle spoke startup-failure: ${health.detail} — ${BUCKLE_SPOKE_LABEL} crash-looping (recovery map buckle-4101)`
			: `buckle spoke :4101 not answering — ${BUCKLE_SPOKE_LABEL} (recovery map buckle-4101)`;
	if (!opts.fix) return { issues: [label], fixed: [] };
	const r = await recoverBuckleSpoke(deps, opts.repo);
	if (r.status === "recovered")
		return { issues: [], fixed: [`buckle spoke recovered: ${r.detail}`] };
	if (r.status === "skip-healthy") return { issues: [], fixed: [] };
	const why =
		r.status === "hold-paused"
			? " — automatic recovery paused"
			: r.status === "stale-pointer" ||
					r.status === "unrecoverable" ||
					r.status === "failed"
				? ` — recovery refused: ${r.detail}`
				: "";
	return { issues: [`${label}${why}`], fixed: [] };
};
