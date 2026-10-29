// deploy/singbox/lifecycle.ts — W1260.1: the operable lifecycle for the
// sing-box TUN enforcement kit. Owner 2026-10-24: default-on for every
// detected AI connection through LOCAL BUCKLE's authenticated CONNECT
// egress (W1260.2), with on/off/status and an ordered rollback.
//
// detect  — which watched AI connections exist on this machine
// fill    — template + machine env → a law-clean machine conf (0600)
// on      — ordered bring-up: conf law → sing-box binary → buckle-connect
//           endpoint reach → staged LaunchDaemon → owner sudo door →
//           clash-API liveness. Relay listening BEFORE TUN engage.
// off     — ordered rollback: daemon down → staged plist removed →
//           launchctl proxy env cleared → scutil proxy report.
// status  — the on/off complement: law, binary, process, endpoint, clash API.
//
// The two root steps (brew install, sudo bootstrap) stay OWNER steps: the
// verbs stage everything and print the exact resume command — pause, never
// prompt, never silently degrade the enforcement.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	checkConfigLaw,
	defaultConfPath,
	fetchConnections,
	readConf,
	templatePath,
} from "./singbox.ts";
import {
	CONNECT_PORT_DEFAULT,
	CONNECT_SERVER,
	bundleOf,
	connectTagOf,
	transportPresence,
} from "./watched.ts";
import { runCli } from "../../hooks/lib/verb-kit.ts";
import type { Parsed } from "../../hooks/lib/verb-kit.ts";

// ─── the host seam ───────────────────────────────────────────────────────────

/** One child-process outcome. */
export interface CmdResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Everything the lifecycle touches on the host — injectable so tests stay
 *  off the real machine (spawn, fs, TCP, clash API). */
export interface LifecycleIo {
	exists(path: string): boolean;
	run(cmd: string[]): Promise<CmdResult>;
	which(name: string): string | null;
	probeTcp(host: string, port: number): Promise<boolean>;
	probeClash(controller: string, secret: string): Promise<boolean>;
}

/** The real host seam. Pipes are ReadableStreams — drained via Response. */
export const realIo = (): LifecycleIo => ({
	exists: (path) => existsSync(path),
	run: async (cmd) => {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { code: await proc.exited, stdout, stderr };
	},
	which: (name) => Bun.which(name),
	probeTcp: (host, port) =>
		new Promise<boolean>((resolve) => {
			let done = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (ok: boolean): void => {
				if (done) return;
				done = true;
				if (timer !== undefined) clearTimeout(timer);
				resolve(ok);
			};
			timer = setTimeout(() => finish(false), 1500);
			timer.unref?.();
			Bun.connect({ hostname: host, port, socket: { data() {} } }).then(
				(socket) => {
					socket.end();
					finish(true);
				},
				() => finish(false),
			);
		}),
	probeClash: async (controller, secret) => {
		try {
			await fetchConnections(controller, secret, 1200);
			return true;
		} catch {
			return false;
		}
	},
});

// ─── shared pieces ───────────────────────────────────────────────────────────

/** The root LaunchDaemon label (system domain — TUN needs root). */
export const DAEMON_LABEL = "com.suspenders.singbox-tun";

/** Where `on` stages the LaunchDaemon plist before the owner sudo step. */
export const stagedPlistPath = (): string => {
	const override = process.env.KLH_SINGBOX_PLIST;
	if (override) return override;
	return join(homedir(), ".config", "klh", "singbox-tun.plist");
};

/** The machine proxy env keys the W1234 launchctl face owns — the rollback
 *  clears exactly these, nothing else. */
export const PROXY_ENV_KEYS = [
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"ANTHROPIC_BASE_URL",
] as const;

// ─── env knobs (config-over-code) ────────────────────────────────────────────

const envOf = (k: string): string | null => {
	const v = process.env[k];
	return v === undefined || v.length === 0 ? null : v;
};

/** The CONNECT egress port — BUCKLE_CONNECT_PORT > the fleet-agreed 4103. */
export const connectPortOf = (): number => {
	const raw = envOf("BUCKLE_CONNECT_PORT");
	if (raw === null) return CONNECT_PORT_DEFAULT;
	const n = Number(raw);
	return Number.isSafeInteger(n) && n >= PORT_MIN && n <= PORT_MAX
		? n
		: CONNECT_PORT_DEFAULT;
};

const PORT_MIN = 1;
const PORT_MAX = 65535;

/** The clash API face the status/liveness probes ride. */
export interface ClashEndpoint {
	controller: string;
	port: number;
	secret: string;
}

/** The clash API endpoint from machine env (KLH_SINGBOX_CLASH_PORT > 9090,
 *  CLASH_API_SECRET override; fill mints one when absent). */
export const clashOf = (): ClashEndpoint => {
	const raw = envOf("KLH_SINGBOX_CLASH_PORT");
	const n = raw === null ? Number.NaN : Number(raw);
	const port =
		Number.isSafeInteger(n) && n >= PORT_MIN && n <= PORT_MAX ? n : 9090;
	return {
		controller: `${CONNECT_SERVER}:${port}`,
		port,
		secret: envOf("CLASH_API_SECRET") ?? "",
	};
};

/** The LaunchDaemon body — sing-box runs the machine conf in the system
 *  domain (TUN needs root); KeepAlive holds enforcement, ThrottleInterval
 *  keeps crash-loops from spinning. The binary path comes from `which` —
 *  never a hardcoded /Users or /opt literal. */
export const renderPlist = (o: {
	binary: string;
	confPath: string;
	logPath: string;
}): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${DAEMON_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${o.binary}</string>
		<string>run</string>
		<string>-c</string>
		<string>${o.confPath}</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>${o.logPath}</string>
	<key>StandardErrorPath</key><string>${o.logPath}</string>
</dict>
</plist>
`;

// ─── fill: template + machine env → runnable conf ───────────────────────────

/** The machine log path (KLH_SINGBOX_LOG > ~/Library/Logs/singbox.log). */
export const logPathOf = (): string => {
	const override = envOf("KLH_SINGBOX_LOG");
	if (override !== null) return override;
	return join(homedir(), "Library", "Logs", "singbox.log");
};

/** Mint a clash API secret — 32 random bytes hex, never typed. */
const mintSecret = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Template placeholder → machine value. BUCKLE_CONNECT_TOKEN has no
 *  default — fill REFUSES without it (a placeholdered conf is exactly the
 *  W1233 "not runnable" failure mode). */
export function fillValuesOf(): {
	values: Record<string, string>;
	missing: string[];
} {
	const token = envOf("BUCKLE_CONNECT_TOKEN");
	const values: Record<string, string> = {
		BUCKLE_CONNECT_PORT: String(connectPortOf()),
		BUCKLE_CONNECT_TOKEN: token ?? "",
		SINGBOX_LOG_FILE: logPathOf(),
		CLASH_API_PORT: String(clashOf().port),
		CLASH_API_SECRET: envOf("CLASH_API_SECRET") ?? mintSecret(),
	};
	const missing: string[] = [];
	if (token === null)
		missing.push(
			"BUCKLE_CONNECT_TOKEN — the W1260.2 CONNECT egress credential (0600 machine env)",
		);
	return { values, missing };
}

/** fill — template + machine env → the machine conf (0600, never over a
 *  real conf without --force). Refuses when a required secret is missing. */
export function lifecycleFill(
	target: string,
	force: boolean,
): { written: string | null; missing: string[] } {
	if (!isAbsolute(target))
		throw new Error(`conf path must be absolute: ${target}`);
	const { values, missing } = fillValuesOf();
	if (missing.length > 0) return { written: null, missing };
	if (!force && existsSync(target)) return { written: null, missing: [] };
	const template = readFileSync(templatePath(), "utf8");
	let text = template;
	// numeric placeholders land as bare JSON numbers (the law wants
	// integers; a quoted "4103" fails the port law) — BEFORE the general
	// string pass, which would otherwise consume the placeholder quoted
	text = text.replaceAll(
		'"server_port": "<BUCKLE_CONNECT_PORT>"',
		`"server_port": ${values.BUCKLE_CONNECT_PORT}`,
	);
	for (const [k, v] of Object.entries(values)) {
		text = text.replaceAll(`<${k}>`, v);
	}
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, target);
	return { written: target, missing: [] };
}

// ─── detect: transport observation (never tool selection) ───────────────────

/** detect — which opaque GUI AI transports exist on THIS machine. Tool
 *  install/detection stays with the fleet-install catalog (owner boundary,
 *  finding.vercel-skills-detection-install-boundary-20261024); this face is
 *  transport observation only. */
export function lifecycleDetect(
	io: Pick<LifecycleIo, "exists"> = realIo(),
): { user: string; label: string; present: boolean }[] {
	return transportPresence(io.exists).map((r) => ({
		user: r.user,
		label: r.label,
		present: r.present,
	}));
}

// ─── on: ordered bring-up (relay BEFORE TUN) ────────────────────────────────

/** The bootstrap state — done (loaded), owner (sudo door printed), failed
 *  (loaded but never answered), skipped (refused before staging). */
export type BootstrapState = "done" | "owner" | "failed" | "skipped";

/** The bring-up outcome — every guard names what it refused and why. */
export interface OnSteps {
	binary: string | null;
	endpoint: string | null;
	staged: string | null;
	bootstrap: BootstrapState;
	clash: boolean;
	verdict: "UP" | "STAGED" | "REFUSED";
	reason: string;
}

const refused = (reason: string): OnSteps => ({
	binary: null,
	endpoint: null,
	staged: null,
	bootstrap: "skipped",
	clash: false,
	verdict: "REFUSED",
	reason,
});

/** on — the ONLY bring-up order: conf law → binary → buckle-connect endpoint
 *  reach (relay BEFORE TUN; an unreachable relay must never capture the
 *  machine) → staged plist → owner sudo door → clash liveness. */
export async function lifecycleOn(
	confPath: string,
	io: LifecycleIo = realIo(),
): Promise<OnSteps> {
	// 1. the conf must pass the fleet law before anything touches the host
	let conf: Record<string, unknown>;
	try {
		conf = readConf(confPath);
	} catch (e) {
		return refused(e instanceof Error ? e.message : String(e));
	}
	const law = checkConfigLaw(conf);
	if (law.length > 0)
		return refused(`conf law: ${law[0]} (run fill, then check)`);
	// 2. the binary must exist
	const binary = io.which("sing-box");
	if (binary === null)
		return refused(
			"sing-box binary not found — owner step: brew install sing-box, then re-run on",
		);
	// 3. the CONNECT relay must answer BEFORE the TUN engages
	const port = connectPortOf();
	const endpoint = `${CONNECT_SERVER}:${port}`;
	if (!(await io.probeTcp(CONNECT_SERVER, port)))
		return refused(
			`buckle-connect endpoint ${endpoint} unreachable — bring up the CONNECT egress first (relay before TUN)`,
		);
	return bringUp(confPath, io);
}

/** bringUp — stages the plist (paths only, never secrets), then the owner
 *  sudo door. */
async function bringUp(confPath: string, io: LifecycleIo): Promise<OnSteps> {
	const staged = stagedPlistPath();
	mkdirSync(dirname(staged), { recursive: true });
	const binary = io.which("sing-box") ?? "sing-box";
	writeFileSync(
		staged,
		renderPlist({ binary, confPath, logPath: logPathOf() }),
		{ mode: 0o644 },
	);
	return sudoDoor(staged, io);
}

/** The owner sudo door — non-interactive attempt first; when cached creds
 *  are absent the exact resume command is printed (pause, never prompt). */
async function sudoDoor(staged: string, io: LifecycleIo): Promise<OnSteps> {
	await io.run([
		"sudo",
		"-n",
		"launchctl",
		"bootout",
		`system/${DAEMON_LABEL}`,
	]);
	const boot = await io.run([
		"sudo",
		"-n",
		"launchctl",
		"bootstrap",
		"system",
		staged,
	]);
	if (boot.code !== 0) {
		const en = await io.run([
			"sudo",
			"-n",
			"launchctl",
			"enable",
			`system/${DAEMON_LABEL}`,
		]);
		if (en.code !== 0) return stagedWait(staged, "owner", io);
	}
	return clashWait(staged, "done", io);
}

/** STAGED — the plist is in place; the printed owner command is the door. */
const stagedWait = (
	staged: string,
	bootstrap: BootstrapState,
	io: LifecycleIo,
): OnSteps => ({
	binary: io.which("sing-box"),
	endpoint: `${CONNECT_SERVER}:${connectPortOf()}`,
	staged,
	bootstrap,
	clash: false,
	verdict: "STAGED",
	reason: `owner step: sudo launchctl bootstrap system ${staged} && sudo launchctl enable system/${DAEMON_LABEL}; then re-run on`,
});

/** The clash-API liveness poll — enforcement is only real when the API
 *  answers; 10s then STAGED with the log path. */
async function clashWait(
	staged: string,
	bootstrap: BootstrapState,
	io: LifecycleIo,
): Promise<OnSteps> {
	const api = clashOf();
	for (let i = 0; i < 10; i++) {
		if (await io.probeClash(api.controller, api.secret)) {
			const endpoint = `${CONNECT_SERVER}:${connectPortOf()}`;
			return {
				binary: io.which("sing-box"),
				endpoint,
				staged,
				bootstrap,
				clash: true,
				verdict: "UP",
				reason: `daemon up, clash api ${api.controller} answering, CONNECT relay ${endpoint}`,
			};
		}
		await Bun.sleep(1000);
	}
	return {
		binary: io.which("sing-box"),
		endpoint: `${CONNECT_SERVER}:${connectPortOf()}`,
		staged,
		bootstrap,
		clash: false,
		verdict: "STAGED",
		reason: `bootstrap ran but clash api ${api.controller} never answered (10s) — read ${logPathOf()}`,
	};
}

// ─── off: ordered rollback ──────────────────────────────────────────────────

export interface OffSteps {
	daemon: "down" | "absent";
	plistRemoved: boolean;
	envCleared: string[];
	scutilProxy: string;
}

/** off — the ONLY rollback order: daemon down → staged plist removed →
 *  launchctl proxy env cleared → scutil proxy report. Never the reverse. */
export async function lifecycleOff(
	io: LifecycleIo = realIo(),
): Promise<OffSteps> {
	const bootout = await io.run([
		"sudo",
		"-n",
		"launchctl",
		"bootout",
		`system/${DAEMON_LABEL}`,
	]);
	const daemon = bootout.code === 0 ? "down" : "absent";
	const staged = stagedPlistPath();
	let plistRemoved = false;
	if (io.exists(staged)) {
		rmSync(staged, { force: true });
		plistRemoved = true;
	}
	const envCleared: string[] = [];
	for (const key of PROXY_ENV_KEYS) {
		const r = await io.run(["launchctl", "unsetenv", key]);
		if (r.code === 0) envCleared.push(key);
	}
	const sc = await io.run(["scutil", "--proxy"]);
	return {
		daemon,
		plistRemoved,
		envCleared,
		scutilProxy: sc.stdout.trim(),
	};
}

// ─── status: the on/off complement ──────────────────────────────────────────

export interface StatusSteps {
	confLaw: "clean" | "dirty" | "absent";
	lawProblem: string | null;
	binary: string | null;
	daemon: boolean;
	endpoint: boolean;
	clash: boolean;
	verdict: "UP" | "DOWN" | "STAGED" | "DEGRADED";
}

/** status — law, binary, daemon process, CONNECT relay, clash API. UP needs
 *  daemon+clash; a running daemon with a dead relay is DEGRADED (watched
 *  AI traffic fails); a staged plist without a daemon is STAGED. */
export async function lifecycleStatus(
	confPath: string,
	io: LifecycleIo = realIo(),
): Promise<StatusSteps> {
	let confLaw: "clean" | "dirty" | "absent" = "absent";
	let lawProblem: string | null = null;
	try {
		const law = checkConfigLaw(readConf(confPath));
		confLaw = law.length === 0 ? "clean" : "dirty";
		lawProblem = law[0] ?? null;
	} catch {
		// absent/unparseable conf — status reports it, never throws
	}
	const binary = io.which("sing-box");
	const daemon = (await io.run(["pgrep", "-x", "sing-box"])).code === 0;
	const port = connectPortOf();
	const endpoint = await io.probeTcp(CONNECT_SERVER, port);
	const api = clashOf();
	const clash = await io.probeClash(api.controller, api.secret);
	const staged = io.exists(stagedPlistPath());
	const verdict =
		daemon && clash && endpoint
			? "UP"
			: daemon && !endpoint
				? "DEGRADED"
				: staged
					? "STAGED"
					: "DOWN";
	return {
		confLaw,
		lawProblem,
		binary,
		daemon,
		endpoint,
		clash,
		verdict,
	};
}

// ─── the CLI face (own door — avoids the singbox.ts import cycle) ───────────

const confArgOf = (p: Parsed): string => {
	const flag = p.flag("--conf");
	if (flag !== null) return flag;
	return defaultConfPath();
};

const runFill = (p: Parsed): number => {
	const out = lifecycleFill(confArgOf(p), p.flag("--force") !== null);
	if (out.missing.length > 0) {
		for (const m of out.missing) console.log(`✗ missing ${m}`);
		return 1;
	}
	if (out.written === null) {
		console.log(
			`= ${confArgOf(p)} already exists — untouched (pass --force to refill)`,
		);
		return 0;
	}
	console.log(`SINGBOX-FILL: ✓ ${out.written} (0600) — next: on`);
	return 0;
};

const runDetect = (): number => {
	const rows = lifecycleDetect();
	for (const r of rows) {
		console.log(
			`  ${r.present ? "✓" : "✗"} ${r.label} — ${bundleOf(r.user) ?? "?"} (egress ${connectTagOf(r.user)})`,
		);
	}
	const present = rows.filter((r) => r.present).length;
	console.log(
		`SINGBOX-DETECT: ${present}/${rows.length} GUI transport(s) present`,
	);
	console.log(
		"= tool install/detection rides the fleet-install catalog (hooks/bin/fleet-install.ts) — this face observes transports only",
	);
	return 0;
};

const runOn = async (p: Parsed): Promise<number> => {
	const out = await lifecycleOn(confArgOf(p));
	console.log(`SINGBOX-ON: ${out.verdict} - ${out.reason}`);
	return out.verdict === "UP" ? 0 : out.verdict === "STAGED" ? 4 : 1;
};

const runOff = async (): Promise<number> => {
	const out = await lifecycleOff();
	console.log(
		`SINGBOX-OFF: DOWN - daemon ${out.daemon}, plist ${out.plistRemoved ? "removed" : "absent"}, env cleared [${out.envCleared.join(", ")}]`,
	);
	console.log(out.scutilProxy);
	return 0;
};

const runStatus = async (p: Parsed): Promise<number> => {
	const s = await lifecycleStatus(confArgOf(p));
	console.log(
		`  law: ${s.confLaw}${s.lawProblem === null ? "" : ` (${s.lawProblem})`}`,
	);
	console.log(
		`  binary: ${s.binary ?? "not found"} | daemon: ${s.daemon ? "running" : "stopped"} | relay: ${s.endpoint ? "reachable" : "down"} | clash: ${s.clash ? "answering" : "silent"}`,
	);
	console.log(`SINGBOX-STATUS: ${s.verdict}`);
	return s.verdict === "UP"
		? 0
		: s.verdict === "DEGRADED"
			? 2
			: s.verdict === "STAGED"
				? 4
				: 1;
};

if (import.meta.main) {
	void runCli({
		prog: "singbox-lifecycle",
		about:
			"sing-box TUN kit lifecycle (W1260.1): default-on through the buckle CONNECT egress",
		verbs: [
			{
				name: "fill",
				usage:
					"usage: singbox-lifecycle fill [--conf <absolute path>] [--force]",
				flags: ["--conf", "--force"],
				run: runFill,
			},
			{
				name: "detect",
				usage: "usage: singbox-lifecycle detect",
				flags: [],
				run: runDetect,
			},
			{
				name: "on",
				usage: "usage: singbox-lifecycle on [--conf <absolute path>]",
				flags: ["--conf"],
				run: runOn,
			},
			{
				name: "off",
				usage: "usage: singbox-lifecycle off",
				flags: [],
				run: runOff,
			},
			{
				name: "status",
				usage: "usage: singbox-lifecycle status [--conf <absolute path>]",
				flags: ["--conf"],
				run: runStatus,
			},
		],
		epilog:
			"machine conf: ~/.config/klh/singbox.json (KLH_SINGBOX_CONF overrides); owner steps print their exact commands — never prompted",
	});
}
