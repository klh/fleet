#!/usr/bin/env bun
// W185 — speedy umbrella installer: one command brings up the whole klh chain
// (belt + buckle + suspenders + klh/local + the local-llm swarm).
//
// Laws (docs/laws.md): spoke install baseline — the chain ALWAYS brings up the
// swarm via suspenders install.sh with BELT_TIER=minimal (smallest-fit, ≤4GB
// residents); degradation — an optional layer failing never aborts the chain;
// centralized ledger — this installer carries state on disk, never todo lists.
//
//   bun bin/install-fleet.ts [--dry-run] [--skip-models] [--only <phase>]
//
// Phases (brief order): deps → belt → buckle → suspenders → local.
// `belt` and `suspenders` share one installer acquisition: the swarm comes up
// BY running the suspenders installer (BELT_TIER=minimal), so on a fresh host
// the belt phase brings the control plane with it and the suspenders phase
// then reports present/skip — both phases stay independently idempotent.
// The hub ask sits at install end: default standalone, yes exchanges a W173
// enrollment code for a spoke token. Hub entries are written W230-compatible:
// {name, url, token_env} — the token itself NEVER lands in config, only in a
// 0600 env file, referenced by env name.
//
// ONE revision (W422.20): every phase consumes the same fleet monorepo
// checkout — never the archived legacy repos. withFleetCheckout resolves the
// source once: FLEET_CHECKOUT (explicit), else the checkout containing this
// script (running from a clone installs THAT revision), else a shallow clone
// of FLEET_REPO_URL at FLEET_REF. Phases then run packages/<name> installers
// inside that root, so belt/buckle/suspenders/local can never drift apart.
//
// Everything spawns through argument arrays, never shell strings; launchd
// gets an absolute bun path (belt lesson — launchd PATH is minimal).

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname, homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────

const HUB_ASK_PROMPT =
	"Do you want to buckle up and connect to a belt hub? [y/N] ";
const TOKEN_ENV_NAME = "KLH_HUB_SPOKE_TOKEN";
// The fleet monorepo is the ONLY living source (the 9 originals are archived
// and push-dead); env overrides pick forks/mirrors or pin a revision.
const FLEET_REPO = () =>
	process.env.FLEET_REPO_URL ?? "https://github.com/klh/fleet";
const FLEET_REF = () => process.env.FLEET_REF ?? "main";
// Explicit fleet checkout (config-over-code escape hatch for testing/offline).
const FLEET_CHECKOUT = () => process.env.FLEET_CHECKOUT;
const SUSPENDERS_MARKER = () =>
	join(fleetHome(), ".claude/hooks/suspenders/bin/work.ts");
const SWARM_MARKER = () => join(fleetHome(), ".claude/local-llm/registry.ts");
const BUCKLE_MARKER = () => join(fleetHome(), ".claude/buckle/src/server.ts");
const KLH_LOCAL_MARKER = () => join(fleetHome(), ".local/bin/klh-local");
const HUB_CONFIG = () => join(fleetHome(), ".claude/local-llm/hubs.json");
const HUB_ENV = () => join(fleetHome(), ".claude/local-llm/hub.env");
const LAST_POLICY_PULL = () =>
	join(fleetHome(), ".claude/local-llm/last-policy-pull.json");

// ─── Small helpers ────────────────────────────────────────────────────────

function fleetHome(): string {
	return process.env.HOME ?? homedir();
}

function which(tool: string): string | null {
	const r = spawnSync("which", [tool], { encoding: "utf8" });
	if (r.status === 0 && r.stdout && r.stdout.trim().length > 0)
		return r.stdout.trim();
	return null;
}

// Absolute bun for launchd (belt lesson: launchd PATH is minimal).
function resolveBun(): string {
	for (const p of ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]) {
		if (existsSync(p)) return p;
	}
	return which("bun") ?? "bun";
}

function warn(msg: string): void {
	console.error(`[WARN] ${msg}`);
}

function shortHostname(): string {
	return hostname().split(".")[0] ?? hostname();
}

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "klh-fleet-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function cloneShallow(repo: string, into: string, ref?: string): boolean {
	const args = ["clone", "--depth", "1", "--single-branch"];
	if (ref) args.push("--branch", ref);
	args.push(repo, into);
	const r = spawnSync("git", args, { stdio: "pipe" });
	return r.status === 0;
}

// ─── The plan ─────────────────────────────────────────────────────────────

export type PhaseId = "deps" | "belt" | "buckle" | "suspenders" | "local";

export interface PhaseStep {
	phase: PhaseId;
	label: string;
	state: "present — skip" | "install" | "verify";
}

export interface FleetFlags {
	dryRun: boolean;
	skipModels: boolean;
	only: PhaseId | null;
}

export function buildPlan(flags: FleetFlags): PhaseStep[] {
	const steps: PhaseStep[] = [];
	if (!flags.only) {
		steps.push({
			phase: "deps",
			label: `verify toolchain (git, curl, jq; bun: ${resolveBun()})`,
			state: "verify",
		});
	}
	if (!flags.only || flags.only === "belt") {
		steps.push({
			phase: "belt",
			label:
				"local-llm swarm via suspenders install.sh (BELT_TIER=minimal smallest-fit)",
			state: existsSync(SWARM_MARKER()) ? "present — skip" : "install",
		});
	}
	if (!flags.only || flags.only === "buckle") {
		steps.push({
			phase: "buckle",
			label:
				"packages/buckle — bun install, launchd com.klh.buckle (shadow :4101)",
			state: existsSync(BUCKLE_MARKER()) ? "present — skip" : "install",
		});
	}
	if (!flags.only || flags.only === "suspenders") {
		steps.push({
			phase: "suspenders",
			label: "control plane (--wire --with-launchd)",
			state: existsSync(SUSPENDERS_MARKER()) ? "present — skip" : "install",
		});
	}
	if (!flags.only || flags.only === "local") {
		steps.push({
			phase: "local",
			label:
				"klh/local + register suspenders.local (:7799), belt.local (:7791)",
			state: existsSync(KLH_LOCAL_MARKER()) ? "present — skip" : "install",
		});
	}
	if (!flags.only) {
		steps.push({
			phase: "local",
			label: `hub ask — "${HUB_ASK_PROMPT.trim()}" — default standalone`,
			state: "verify",
		});
	}
	return steps;
}

function printPlan(flags: FleetFlags): void {
	const steps = buildPlan(flags);
	console.log(
		"klh fleet install — plan (--dry-run: nothing executed, nothing prompted)",
	);
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i];
		const n = String(i + 1).padStart(2, "0");
		console.log(`  ${n}. ${s.phase.padEnd(11)} ${s.label} — ${s.state}`);
	}
	const flagsLine = [
		`--dry-run`,
		flags.skipModels
			? `--skip-models (offline install)`
			: `model downloads per BELT_TIER=minimal`,
	];
	console.log(`  flags: ${flagsLine.join(" · ")}`);
	console.log(
		`  laws: docs/laws.md (spoke install baseline, degradation, PQC wire)`,
	);
}

// ─── Phases ───────────────────────────────────────────────────────────────

interface PhaseResult {
	ok: boolean;
	detail: string;
}

function depsPhase(): PhaseResult {
	const missing: string[] = [];
	for (const tool of ["git", "curl", "jq"]) {
		if (!which(tool)) missing.push(tool);
	}
	if (missing.length === 0) {
		return { ok: true, detail: `toolchain ok (bun: ${resolveBun()})` };
	}
	const brew = which("brew");
	if (brew) {
		const r = spawnSync(brew, ["install", ...missing], { stdio: "inherit" });
		if (r.status === 0)
			return { ok: true, detail: `installed ${missing.join(", ")}` };
	}
	return {
		ok: false,
		detail: `missing ${missing.join(", ")} — later layers may degrade`,
	};
}

// A fleet monorepo root: the tree that carries every phase installer.
export function isFleetRoot(dir: string): boolean {
	return existsSync(join(dir, "packages/suspenders/install.sh"));
}

// ONE acquisition (W422.20): resolve the fleet checkout every phase consumes.
// Order: FLEET_CHECKOUT (explicit) → the checkout containing this script →
// a shallow clone of FLEET_REPO_URL at FLEET_REF in a temp dir (removed after).
// fn(null) = no fleet source available — phases degrade individually.
export function withFleetCheckout<T>(fn: (root: string | null) => T): T {
	const explicit = FLEET_CHECKOUT();
	if (explicit && isFleetRoot(explicit)) return fn(explicit);
	// import.meta.dir = <root>/packages/speedy/bin when run from a clone.
	const bin = import.meta.dir;
	const candidates = [join(bin, "..", "..", ".."), join(bin, "..")];
	for (const candidate of candidates) {
		if (isFleetRoot(candidate)) return fn(candidate);
	}
	return withTempDir((dir) => {
		const checkout = join(dir, "fleet");
		if (!cloneShallow(FLEET_REPO(), checkout, FLEET_REF())) return fn(null);
		return fn(checkout);
	});
}

function beltPhase(flags: FleetFlags): PhaseResult {
	if (existsSync(SWARM_MARKER())) {
		return {
			ok: true,
			detail:
				"swarm already deployed — keeping its tier (upgrade never demotes)",
		};
	}
	return withFleetCheckout((root) => {
		const installer = root
			? join(root, "packages/suspenders/install.sh")
			: null;
		if (!installer)
			return {
				ok: false,
				detail:
					"no fleet checkout available (clone failed) — swarm not deployed",
			};
		const env = { ...process.env, BELT_TIER: "minimal" };
		const args = [installer, "--wire", "--with-launchd"];
		if (flags.skipModels) args.push("--skip-models");
		console.log(
			`  → fleet packages/suspenders/install.sh ${args.slice(1).join(" ")} (BELT_TIER=minimal)`,
		);
		const r = spawnSync("/bin/bash", args, { env, stdio: "inherit" });
		if (r.status === 0)
			return {
				ok: true,
				detail: "swarm deployed (BELT_TIER=minimal residents)",
			};
		return {
			ok: false,
			detail:
				"suspenders installer failed — continuing without the swarm (degradation law)",
		};
	});
}

function bucklePhase(): PhaseResult {
	const marker = BUCKLE_MARKER();
	if (existsSync(marker)) {
		return { ok: true, detail: "buckle already deployed" };
	}
	const bunAbs = resolveBun();
	return withFleetCheckout((root) => {
		const source = root ? join(root, "packages/buckle") : null;
		if (!source || !existsSync(join(source, "src/server.ts"))) {
			return {
				ok: false,
				detail:
					"no fleet checkout available (clone failed) — continuing without the router plane",
			};
		}
		const target = join(fleetHome(), ".claude/buckle");
		mkdirSync(target, { recursive: true });
		cpSync(source, target, {
			recursive: true,
			// a dev checkout carries node_modules/.git — the target reinstalls fresh
			filter: (src) => !/(^|\/)node_modules$|(^|\/)\.git$/.test(src),
		});
		const inst = spawnSync(bunAbs, ["install"], {
			cwd: target,
			stdio: "inherit",
		});
		if (inst.status !== 0)
			warn("buckle bun install failed (optional) — continuing without it");
		const plist = writeBucklePlist(target, bunAbs);
		let loadNote = "plist written, not loaded";
		if (plist) {
			const uid = String(userInfo().uid);
			const boot = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], {
				stdio: "pipe",
			});
			loadNote =
				boot.status === 0
					? "launchd loaded (com.klh.buckle)"
					: "launchd bootstrap skipped (already loaded or unsupported)";
		}
		return {
			ok: true,
			detail: `buckle in ${target} — shadow :4101, logs in ~/.claude-insights/ (${loadNote})`,
		};
	});
}

// com.klh.buckle — absolute paths everywhere (launchd has no shell, no PATH).
function writeBucklePlist(target: string, bunAbs: string): string | null {
	if (process.platform !== "darwin") return null;
	const home = fleetHome();
	const insights = join(home, ".claude-insights");
	mkdirSync(insights, { recursive: true });
	const plistPath = join(home, "Library/LaunchAgents/com.klh.buckle.plist");
	mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.klh.buckle</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunAbs}</string>
    <string>${join(target, "src/server.ts")}</string>
  </array>
  <key>WorkingDirectory</key><string>${target}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${home}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(insights, "buckle.log")}</string>
  <key>StandardErrorPath</key><string>${join(insights, "buckle.err")}</string>
</dict>
</plist>
`;
	writeFileSync(plistPath, plist);
	return plistPath;
}

function suspendersPhase(): PhaseResult {
	if (existsSync(SUSPENDERS_MARKER())) {
		return { ok: true, detail: "control plane already installed" };
	}
	return withFleetCheckout((root) => {
		const installer = root
			? join(root, "packages/suspenders/install.sh")
			: null;
		if (!installer)
			return {
				ok: false,
				detail: "no fleet checkout available (clone failed)",
			};
		const r = spawnSync("/bin/bash", [installer, "--wire", "--with-launchd"], {
			stdio: "inherit",
		});
		if (r.status === 0)
			return {
				ok: true,
				detail: "control plane installed (--wire --with-launchd)",
			};
		return {
			ok: false,
			detail: "suspenders installer failed — chain continues degraded",
		};
	});
}

function localPhase(): PhaseResult {
	const klhLocal = KLH_LOCAL_MARKER();
	if (!existsSync(klhLocal)) {
		const ok = withFleetCheckout((root) => {
			const checkout = root ? join(root, "packages/local") : null;
			if (!checkout || !existsSync(join(checkout, "install.sh"))) return false;
			const r = spawnSync("/bin/bash", [join(checkout, "install.sh")], {
				cwd: checkout,
				stdio: "inherit",
			});
			return r.status === 0;
		});
		if (!ok) {
			return {
				ok: false,
				detail:
					"klh/local install failed — .local registration skipped (optional)",
			};
		}
	}
	if (!existsSync(klhLocal)) {
		return {
			ok: false,
			detail:
				"klh-local binary missing after install — registration skipped (optional)",
		};
	}
	const notes: string[] = [];
	for (const reg of [
		{ name: "suspenders", port: "7799" },
		{ name: "belt", port: "7791" },
	]) {
		const r = spawnSync(
			klhLocal,
			["register", reg.name, "--port", reg.port, "--health", "/"],
			{ stdio: "pipe" },
		);
		notes.push(
			r.status === 0
				? `${reg.name}.local (:${reg.port}) ✓`
				: `${reg.name} registration failed (optional)`,
		);
	}
	return { ok: true, detail: notes.join(" · ") };
}

// ─── Hub federation (W173 enroll; standalone default) ────────────────────

export interface HubIO {
	tty: boolean;
	write(s: string): void;
	readLine(): string;
}

export const stdIO: HubIO = {
	tty: process.stdin.isTTY === true,
	write: (s) => process.stdout.write(s),
	readLine: () => {
		const buf = Buffer.alloc(1024);
		let n = 0;
		try {
			n = readSync(0, buf, 0, 1024, null);
		} catch {
			n = 0;
		}
		return buf.toString("utf8", 0, Math.max(n, 0)).replace(/\r?\n$/, "");
	},
};

function hubPaths(): { config: string; envFile: string; lastPull: string } {
	return {
		config: HUB_CONFIG(),
		envFile: HUB_ENV(),
		lastPull: LAST_POLICY_PULL(),
	};
}

function writeHubRoster(roster: unknown[]): void {
	const { config } = hubPaths();
	mkdirSync(join(config, ".."), { recursive: true });
	writeFileSync(config, `${JSON.stringify({ hubs: roster }, null, 2)}\n`);
	chmodSync(config, 0o600);
}

export function writeStandaloneHubConfig(): void {
	writeHubRoster([]);
}

// W230-compatible shape: hubs: [{name, url, token_env, dns_entries}].
// The token NEVER lands in config — it goes to hub.env (0600) and the roster
// references it by env name.
export interface EnrollResponse {
	spoke_id?: string;
	spoke_token?: string;
	dns_entries?: string[];
}

export async function enrollHub(
	url: string,
	code: string,
	io: HubIO,
): Promise<boolean> {
	const base = url.replace(/\/+$/, "");
	if (base.length === 0) {
		warn("hub url required — staying standalone");
		return false;
	}
	let resp: Response;
	try {
		resp = await fetch(`${base}/federation/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, hostname: shortHostname() }),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		warn(`enroll failed at ${base} — staying standalone (degradation law)`);
		return false;
	}
	if (!resp.ok) {
		warn(`enroll rejected (${String(resp.status)}) — staying standalone`);
		return false;
	}
	const body = (await resp.json()) as EnrollResponse;
	const token = body.spoke_token;
	if (!token) {
		warn("enroll response has no spoke_token — staying standalone");
		return false;
	}
	// token → 0600 env file; roster carries the env NAME, never the literal.
	const { envFile } = hubPaths();
	mkdirSync(join(envFile, ".."), { recursive: true });
	writeFileSync(envFile, `${TOKEN_ENV_NAME}=${token}\n`);
	chmodSync(envFile, 0o600);
	writeHubRoster([
		{
			name: shortHostname(),
			url: base,
			token_env: TOKEN_ENV_NAME,
			dns_entries: body.dns_entries ?? [],
		},
	]);
	const spoke = body.spoke_id ? ` (spoke ${body.spoke_id})` : "";
	io.write(`  · enrolled${spoke} at ${base}\n`);
	return true;
}

// First policy pull (heartbeat-on-the-pull) — carries the hub menu.
export async function firstPolicyPull(
	url: string,
	token: string,
	io: HubIO,
): Promise<void> {
	const base = url.replace(/\/+$/, "");
	try {
		const resp = await fetch(`${base}/federation/policy`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!resp.ok) throw new Error(String(resp.status));
		const text = await resp.text();
		const { lastPull } = hubPaths();
		writeFileSync(lastPull, text);
		const policy = JSON.parse(text) as { menu?: unknown };
		const menu = Array.isArray(policy.menu) ? policy.menu : [];
		io.write("  hub menu (what the hub lets this spoke use):\n");
		for (const item of menu) {
			const label =
				typeof item === "string"
					? item
					: String(
							(item as { name?: unknown }).name ??
								(item as { id?: unknown }).id ??
								"",
						);
			io.write(`    • ${label}\n`);
		}
	} catch {
		warn(
			"first policy pull failed — hub config kept; retries at next belt start",
		);
	}
}

// The end-of-install ask. Re-runs never re-prompt and never wipe an enrollment.
export async function hubAsk(io: HubIO = stdIO): Promise<void> {
	const { config } = hubPaths();
	mkdirSync(join(config, ".."), { recursive: true });
	if (existsSync(config) && statSync(config).size > 0) {
		const cfg = JSON.parse(readFileSync(config, "utf8")) as {
			hubs?: { url?: string }[];
		};
		const first = cfg.hubs?.[0];
		io.write(
			first?.url
				? `  ✓ enrolled to ${first.url}\n`
				: "  · hub config present — see /console/settings\n",
		);
		return;
	}
	if (!io.tty) {
		writeStandaloneHubConfig();
		io.write(
			"  · non-interactive — standalone (revisit via /console/settings)\n",
		);
		return;
	}
	io.write(HUB_ASK_PROMPT);
	const answer = io.readLine().trim().toLowerCase();
	if (answer !== "y" && answer !== "yes") {
		writeStandaloneHubConfig();
		io.write(
			"  · standalone (default) — connect later via /console/settings\n",
		);
		return;
	}
	io.write("Hub URL: ");
	const url = io.readLine().trim();
	io.write("Enrollment code: ");
	const code = io.readLine().trim();
	if (!url || !code || !(await enrollHub(url, code, io))) {
		writeStandaloneHubConfig();
		io.write("  · staying standalone — revisit via /console/settings\n");
		return;
	}
	await firstPolicyPull(url, readTokenFromEnvFile() ?? "", io);
	io.write("  · connected — manage via /console/settings\n");
}

function readTokenFromEnvFile(): string | null {
	const { envFile } = hubPaths();
	if (!existsSync(envFile)) return null;
	const line = readFileSync(envFile, "utf8")
		.split("\n")
		.find((l) => l.startsWith(`${TOKEN_ENV_NAME}=`));
	return line ? line.slice(TOKEN_ENV_NAME.length + 1).trim() : null;
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const USAGE = `usage: bun bin/install-fleet.ts [--dry-run] [--skip-models] [--only <phase>]

  --dry-run      print the install plan and exit — touch nothing, prompt nothing
  --skip-models  no model downloads anywhere in the chain (offline install)
  --only <phase> run one phase: deps | belt | buckle | suspenders | local

Phases: deps → belt (swarm via suspenders, BELT_TIER=minimal) → buckle →
suspenders → local (.local registration). The hub ask runs at the end of a
full install — default standalone.`;

function parseArgs(argv: string[]): FleetFlags | null {
	const flags: FleetFlags = { dryRun: false, skipModels: false, only: null };
	const phaseIds: PhaseId[] = ["deps", "belt", "buckle", "suspenders", "local"];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") flags.dryRun = true;
		else if (a === "--skip-models") flags.skipModels = true;
		else if (a === "--only") {
			const v = argv[i + 1];
			if (!v || !phaseIds.includes(v as PhaseId)) {
				console.error(`--only needs one of: ${phaseIds.join(" | ")}`);
				return null;
			}
			flags.only = v as PhaseId;
			i++;
		} else {
			console.error(`unknown flag: ${a}\n${USAGE}`);
			return null;
		}
	}
	return flags;
}

async function main(): Promise<number> {
	const flags = parseArgs(process.argv.slice(2));
	if (!flags) return 2;
	if (flags.dryRun) {
		printPlan(flags);
		return 0;
	}
	const phases: { id: PhaseId; run: () => PhaseResult }[] = [
		{ id: "deps", run: depsPhase },
		{ id: "belt", run: () => beltPhase(flags) },
		{ id: "buckle", run: bucklePhase },
		{ id: "suspenders", run: suspendersPhase },
		{ id: "local", run: localPhase },
	];
	const selected = flags.only
		? phases.filter((p) => p.id === flags.only)
		: phases;
	const results: { id: PhaseId; r: PhaseResult }[] = [];
	for (let i = 0; i < selected.length; i++) {
		const p = selected[i];
		console.log(`[${i + 1}/${selected.length}] ${p.id}`);
		let r: PhaseResult;
		try {
			r = p.run();
		} catch (err) {
			r = {
				ok: false,
				detail: err instanceof Error ? err.message : String(err),
			};
		}
		console.log(`  ${r.ok ? "✓" : "⚠"} ${p.id}: ${r.detail}`);
		results.push({ id: p.id, r });
	}
	if (!flags.only) {
		await hubAsk();
	}
	const degraded = results.filter((x) => !x.r.ok).map((x) => x.id);
	if (degraded.length > 0) {
		warn(
			`degraded layers: ${degraded.join(", ")} — re-run to retry (idempotent)`,
		);
	}
	console.log(
		"done — fleet laws: docs/laws.md · hub roster: ~/.claude/local-llm/hubs.json",
	);
	return 0;
}

if (import.meta.main) {
	main().then((code) => process.exit(code));
}
