// deploy/singbox/windows.ts — W1264.1: Windows sing-box TUN install + AI
// egress coverage CLI (the Windows sibling of the Mac sing-box kit).
// Renders the machine config from the repo template (config-over-code:
// real hosts/keys only ever machine-local), registers an ONSTART SYSTEM
// scheduled task via schtasks (native CLI, argument arrays, no shell), and
// reports status via the clash API. Detection rides the ONE catalog
// (egress.ts → hooks/lib/targets.ts). Authored and unit-tested on macOS;
// live-Windows execution is the explicit pending step — every native call
// is an honest argument array a Windows host can run verbatim.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Parsed } from "../../hooks/lib/verb-kit.ts";
import { defineVerb, runCli } from "../../hooks/lib/verb-kit.ts";
import { buildEgressPlan, singboxEgressRules } from "./egress.ts";

/** Injectable native-command result. */
export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Argument-array-only native runner (no shell ever — automation law). */
export type NativeRunner = (cmd: string[]) => Promise<RunResult>;

/** Default runner: real Bun.spawn, pipes drained after exit. */
export const nativeRunner: NativeRunner = async (cmd) => {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
};

/** Scheduled-task name (one per machine). */
export const WIN_TASK_NAME = "KlhSingboxTun";

type Env = Record<string, string | undefined>;

/** Machine conf dir: %ProgramData%\klh\sing-box (KLH_SINGBOX_WIN_DIR
 *  overrides). Empty-string env counts as unset. */
export const winConfDir = (env: Env = process.env): string => {
	const override = env.KLH_SINGBOX_WIN_DIR;
	if (override) return override;
	return join(env.ProgramData ?? "C:\\ProgramData", "klh", "sing-box");
};

export const winConfPath = (env: Env = process.env): string =>
	join(winConfDir(env), "config.json");

/** Binary dir staged out-of-band (offline LAN): sing-box.exe + wintun.dll
 *  must sit together; the official windows-amd64 zip ships both. */
export const winBinDir = (env: Env = process.env): string => {
	const override = env.KLH_SINGBOX_WIN_BIN;
	if (override) return override;
	return join(winConfDir(env), "bin");
};

/** The repo template — fleet-law reference shape with placeholders. */
export const templatePath = (): string =>
	join(import.meta.dir, "config.windows.template.json");

/** The machine values the template placeholders need (config-over-code:
 *  never committed, never argv defaults). Empty string = unset. */
export interface ConfValues {
	relayHost: string;
	relayPort: string;
	clashPort: string;
	clashSecret: string;
	logFile: string;
	missing: string[];
}

const envVal = (env: Env, key: string): string | undefined => {
	const v = env[key];
	return v !== undefined && v.length > 0 ? v : undefined;
};

export const confValues = (env: Env = process.env): ConfValues => {
	const relayHost = envVal(env, "KLH_SINGBOX_RELAY_HOST");
	const relayPort = envVal(env, "KLH_SINGBOX_RELAY_PORT");
	const clashPort = envVal(env, "KLH_SINGBOX_CLASH_PORT");
	const clashSecret = envVal(env, "KLH_SINGBOX_CLASH_SECRET");
	const logFile = envVal(env, "KLH_SINGBOX_LOG_FILE");
	const missing: string[] = [];
	if (relayHost === undefined) missing.push("KLH_SINGBOX_RELAY_HOST");
	if (relayPort === undefined) missing.push("KLH_SINGBOX_RELAY_PORT");
	if (clashPort === undefined) missing.push("KLH_SINGBOX_CLASH_PORT");
	if (clashSecret === undefined) missing.push("KLH_SINGBOX_CLASH_SECRET");
	if (logFile === undefined) missing.push("KLH_SINGBOX_LOG_FILE");
	return { relayHost, relayPort, clashPort, clashSecret, logFile, missing };
};

/** Fill the template placeholders + inject the egress route rules. Pure
 *  JSON work — nothing written until the caller persists. Placeholders are
 *  substituted at the OBJECT level (post-parse): machine values like
 *  C:\ProgramData log paths are backslash-rich and would corrupt a
 *  string-level replace before JSON.parse. */
export function renderConfig(env: Env = process.env): {
	json: string;
	values: ConfValues;
	unfilled: string[];
} {
	const values = confValues(env);
	const root: unknown = JSON.parse(readFileSync(templatePath(), "utf8"));
	if (typeof root !== "object" || root === null || Array.isArray(root)) {
		throw new Error("template root must be a JSON object");
	}
	const fill: Record<string, string | undefined> = {
		SINGBOX_LOG_FILE: values.logFile,
		HUB_RELAY_HOST: values.relayHost,
		HUB_RELAY_PORT: values.relayPort,
		CLASH_API_PORT: values.clashPort,
		CLASH_API_SECRET: values.clashSecret,
	};
	const unfilled: string[] = [];
	const fillNode = (node: unknown): unknown => {
		if (typeof node === "string") {
			const m = /^<([A-Z][A-Z0-9_]*)>$/.exec(node);
			if (m !== null) {
				const key = m[1] ?? "";
				const replacement = fill[key];
				if (replacement !== undefined) return replacement;
				unfilled.push(key);
				return node;
			}
		}
		if (Array.isArray(node)) return node.map(fillNode);
		if (typeof node === "object" && node !== null) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(node)) out[k] = fillNode(v);
			return out;
		}
		return node;
	};
	const conf = fillNode(root) as Record<string, unknown>;
	const route = conf.route;
	if (typeof route !== "object" || route === null || Array.isArray(route)) {
		throw new Error("template route must be an object");
	}
	(route as Record<string, unknown>).rules = singboxEgressRules();
	return {
		json: JSON.stringify(conf, null, "\t"),
		values,
		unfilled: [...new Set(unfilled)],
	};
}

export const SCHTASKS_CREATE = "schtasks";

/** ONSTART + SYSTEM: TUN auto_route needs the machine account, not a
 *  logon-scoped task. The /TR value quotes the binary and conf paths. */
export const schtasksCreateArgs = (
	binPath: string,
	confPath: string,
): string[] => [
	"/Create",
	"/F",
	"/TN",
	WIN_TASK_NAME,
	"/TR",
	`"${binPath}" run -c "${confPath}"`,
	"/SC",
	"ONSTART",
	"/RU",
	"SYSTEM",
];

export const schtasksQueryArgs = (): string[] => [
	"/Query",
	"/TN",
	WIN_TASK_NAME,
	"/FO",
	"LIST",
];

export const schtasksRunArgs = (): string[] => ["/Run", "/TN", WIN_TASK_NAME];

export const schtasksDeleteArgs = (): string[] => [
	"/Delete",
	"/TN",
	WIN_TASK_NAME,
	"/F",
];

/** `net session` succeeds only for an elevated token — the TUN admin probe. */
export const ADMIN_PROBE = ["net", "session"];

/** Shared injectable host surface (tests pass fakes; prod passes nothing). */
export interface HostDeps {
	runner?: NativeRunner;
	env?: Env;
	platform?: string;
}

const host = (
	deps: HostDeps,
): { runner: NativeRunner; env: Env; platform: string } => ({
	runner: deps.runner ?? nativeRunner,
	env: deps.env ?? process.env,
	platform: deps.platform ?? process.platform,
});

/** Install: admin probe → render → write conf → ONSTART SYSTEM task →
 *  start. Throws naming the failing step; returns the step log. */
export async function installTun(deps: HostDeps = {}): Promise<string[]> {
	const { runner, env, platform } = host(deps);
	if (platform !== "win32") {
		throw new Error(`windows host required (platform: ${platform})`);
	}
	const values = confValues(env);
	if (values.missing.length > 0) {
		throw new Error(
			`missing machine values (config-over-code): ${values.missing.join(", ")}`,
		);
	}
	const binDir = winBinDir(env);
	const exe = join(binDir, "sing-box.exe");
	const wintun = join(binDir, "wintun.dll");
	for (const f of [exe, wintun]) {
		if (!existsSync(f)) {
			throw new Error(
				`missing ${f} — stage the official sing-box windows-amd64 zip first`,
			);
		}
	}
	const admin = await runner(ADMIN_PROBE);
	if (admin.code !== 0) {
		throw new Error("administrator required for TUN (net session denied)");
	}
	return writeAndRegister(runner, env, exe);
}

/** Conf write + task registration (post-admin tail, split for testability). */
async function writeAndRegister(
	runner: NativeRunner,
	env: Env,
	exe: string,
): Promise<string[]> {
	const rendered = renderConfig(env);
	if (rendered.unfilled.length > 0) {
		throw new Error(`unfilled: ${rendered.unfilled.join(", ")}`);
	}
	const confPath = winConfPath(env);
	mkdirSync(winConfDir(env), { recursive: true });
	writeFileSync(confPath, rendered.json);
	const steps = [`conf written: ${confPath}`];
	const create = await runner([
		SCHTASKS_CREATE,
		...schtasksCreateArgs(exe, confPath),
	]);
	if (create.code !== 0)
		throw new Error(`schtasks /Create failed: ${errOf(create)}`);
	steps.push(`task registered: ${WIN_TASK_NAME}`);
	const run = await runner([SCHTASKS_CREATE, ...schtasksRunArgs()]);
	if (run.code !== 0) throw new Error(`schtasks /Run failed: ${errOf(run)}`);
	steps.push(`task started: ${WIN_TASK_NAME}`);
	return steps;
}

const errOf = (r: RunResult): string =>
	(r.stderr.trim() || r.stdout.trim() || "no output").slice(0, 200);

/** Bearer-authed clash API probe — the liveness face of the running TUN.
 *  Transport metadata only: connections/counts, never request contents
 *  (Buckle CONNECT is L4; the encrypted wire stays invisible). */
export interface ClashDeps {
	env?: Env;
	fetcher?: typeof fetch;
}

export async function clashVersion(
	deps: ClashDeps = {},
): Promise<{ ok: boolean; version: string | null; error: string | null }> {
	const env = deps.env ?? process.env;
	const port = envVal(env, "KLH_SINGBOX_CLASH_PORT");
	const secret = envVal(env, "KLH_SINGBOX_CLASH_SECRET");
	if (port === undefined || secret === undefined) {
		return { ok: false, version: null, error: "clash port/secret unset" };
	}
	const fetcher = deps.fetcher ?? fetch;
	try {
		const res = await fetcher(`http://127.0.0.1:${port}/version`, {
			headers: { Authorization: `Bearer ${secret}` },
			signal: AbortSignal.timeout(3000),
		});
		if (res.status !== 200)
			return { ok: false, version: null, error: `HTTP ${res.status}` };
		const body: unknown = await res.json();
		const version =
			typeof body === "object" && body !== null && "version" in body
				? String((body as Record<string, unknown>).version)
				: "unknown";
		return { ok: true, version, error: null };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, version: null, error: msg };
	}
}

export interface StatusReport {
	platform: string;
	task: RunResult;
	clash: { ok: boolean; version: string | null; error: string | null };
}

/** Status: the scheduled-task state + the clash API liveness probe. */
export async function statusTun(
	deps: HostDeps & ClashDeps = {},
): Promise<StatusReport> {
	const { runner, env, platform } = host(deps);
	const task = await runner([SCHTASKS_CREATE, ...schtasksQueryArgs()]);
	const clash = await clashVersion({ env, fetcher: deps.fetcher });
	return { platform, task, clash };
}

/** Uninstall: remove the task + the machine conf dir. Refuses without
 *  `yes` — it deletes machine-local files. */
export async function uninstallTun(
	yes: boolean,
	deps: HostDeps = {},
): Promise<string[]> {
	const { runner, env, platform } = host(deps);
	if (!yes) throw new Error("uninstall requires --yes (deletes conf dir)");
	if (platform !== "win32") {
		throw new Error(`windows host required (platform: ${platform})`);
	}
	const del = await runner([SCHTASKS_CREATE, ...schtasksDeleteArgs()]);
	if (del.code !== 0) throw new Error(`schtasks /Delete failed: ${errOf(del)}`);
	const confDir = winConfDir(env);
	rmSync(confDir, { recursive: true, force: true });
	return [`task deleted: ${WIN_TASK_NAME}`, `conf dir removed: ${confDir}`];
}

/** check verb body: prerequisite report, machine-honest (non-win32 reports
 *  the platform miss instead of probing). Returns ok + printable lines. */
export async function checkTun(
	deps: HostDeps & ClashDeps = {},
): Promise<{ ok: boolean; lines: string[] }> {
	const { runner, env, platform } = host(deps);
	const lines: string[] = [];
	let ok = platform === "win32";
	lines.push(`platform: ${platform}${ok ? "" : " (windows required)"}`);
	const values = confValues(env);
	lines.push(
		`machine values: ${values.missing.length === 0 ? "present" : `missing ${values.missing.join(", ")}`}`,
	);
	if (values.missing.length > 0) ok = false;
	const binDir = winBinDir(env);
	const exe = join(binDir, "sing-box.exe");
	const wintun = join(binDir, "wintun.dll");
	lines.push(`sing-box.exe: ${existsSync(exe) ? "found" : `missing ${exe}`}`);
	lines.push(
		`wintun.dll: ${existsSync(wintun) ? "found" : `missing ${wintun}`}`,
	);
	if (!existsSync(exe) || !existsSync(wintun)) ok = false;
	lines.push(`template: ${existsSync(templatePath()) ? "found" : "missing"}`);
	if (!existsSync(templatePath())) ok = false;
	if (platform === "win32") {
		const admin = await runner(ADMIN_PROBE);
		lines.push(`admin: ${admin.code === 0 ? "elevated" : "not elevated"}`);
		if (admin.code !== 0) ok = false;
	}
	return { ok, lines };
}

// — CLI door (verb-kit W651): check | plan | render | install | status | uninstall —

const REPO = `${import.meta.dir}/../..`;

const printCheck = async (): Promise<number> => {
	const { ok, lines } = await checkTun();
	for (const l of lines) console.log(l);
	return ok ? 0 : 1;
};

const printPlan = async (parsed: Parsed): Promise<void> => {
	const plan = await buildEgressPlan(REPO);
	if (parsed.flag("--json") === "true") {
		console.log(JSON.stringify(plan, null, "\t"));
		return;
	}
	const installed = plan.targets.filter((t) => t.installed);
	console.log(`catalog targets installed: ${installed.length}`);
	for (const t of installed) {
		console.log(`  ${t.displayName}: ${t.egressMode}`);
	}
};

const verbHandlers = {
	check: (): Promise<number> => printCheck(),
	plan: (parsed: Parsed): Promise<void> => printPlan(parsed),
	render: (): void => {
		const rendered = renderConfig();
		if (rendered.unfilled.length > 0) {
			console.error(`render: unfilled ${rendered.unfilled.join(", ")}`);
			process.exit(1);
		}
		console.log(rendered.json);
	},
	install: async (): Promise<void> => {
		for (const s of await installTun()) console.log(`install: ${s}`);
	},
	status: async (): Promise<void> => {
		const r = await statusTun();
		console.log(`platform: ${r.platform}`);
		console.log(
			`task: exit ${r.task.code} — ${r.task.stdout.trim() || r.task.stderr.trim()}`,
		);
		console.log(
			`clash: ${r.clash.ok ? `up ${r.clash.version ?? ""}` : `down ${r.clash.error ?? ""}`}`,
		);
	},
	uninstall: async (): Promise<void> => {
		for (const s of await uninstallTun(true)) console.log(`uninstall: ${s}`);
	},
};

const VERBS = [
	defineVerb({
		name: "check",
		usage: "usage: singbox-win check",
		run: verbHandlers.check,
	}),
	defineVerb({
		name: "plan",
		usage: "usage: singbox-win plan [--json]",
		switches: ["--json"],
		run: verbHandlers.plan,
	}),
	defineVerb({
		name: "render",
		usage: "usage: singbox-win render",
		run: verbHandlers.render,
	}),
	defineVerb({
		name: "install",
		usage: "usage: singbox-win install",
		run: verbHandlers.install,
	}),
	defineVerb({
		name: "status",
		usage: "usage: singbox-win status",
		run: verbHandlers.status,
	}),
	defineVerb({
		name: "uninstall",
		usage: "usage: singbox-win uninstall --yes",
		flags: ["--yes"],
		reqFlags: ["--yes"],
		run: verbHandlers.uninstall,
	}),
];

if (import.meta.main) {
	await runCli({
		prog: "singbox-win",
		about: "Windows sing-box TUN install + AI egress coverage (W1264.1)",
		verbs: VERBS,
	});
}
