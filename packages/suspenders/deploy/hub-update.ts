#!/usr/bin/env bun
// Provider-agnostic release reconciliation for the hub control plane.
// The controller runs this on the host; no hub container receives Docker
// control or a writable host mount.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	inQuietHours,
	loadStack,
	STACK_PATH,
	stackConfIssues,
	type HubProfile,
	type StackConfig,
} from "../hooks/lib/stack-config.ts";
import {
	assertDeployRefsExist,
	resolveHubOrigin,
} from "./hub-ref-preflight.ts";
import { sshOpts } from "./hub-remote.ts";

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function parts(tag: string): [number, number, number] | null {
	const match = TAG.exec(tag);
	if (!match) return null;
	const nums = match.slice(1).map(Number);
	if (nums.some((n) => !Number.isSafeInteger(n))) return null;
	return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

export function compareReleaseTags(left: string, right: string): number {
	const a = parts(left);
	const b = parts(right);
	if (!a || !b) throw new Error("release tags must be vMAJOR.MINOR.PATCH");
	for (let index = 0; index < 3; index++) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

/** Only exact lightweight or annotated tag refs count. Ignore peeled refs,
 * branch names and malformed versions. */
export function latestReleaseTag(lsRemote: string): string | null {
	const tags = lsRemote
		.split("\n")
		.map((line) => /^\S+\s+refs\/tags\/(v[^\s^]+)$/.exec(line)?.[1])
		.filter((tag): tag is string => !!tag && parts(tag) !== null);
	return tags.sort(compareReleaseTags).at(-1) ?? null;
}

/** A private overlay ref that differs from the shared release is an explicit
 * operator pin. A matching release tag advances only after origin preflight. */
export function pinnedOverlayRef(
	hub: HubProfile,
	version: string | undefined,
): boolean {
	return (
		resolveHubOrigin(hub, hub.version_override ?? version).overlay &&
		hub.repos?.ref !== version
	);
}

/** A release updates the shared Fleet version and release-tracking refs.
 * Independent overlay SHA/tag and explicit canary pins stay unchanged. */
export function stackAtRelease(stack: StackConfig, tag: string): StackConfig {
	if (!parts(tag)) throw new Error("release tag must be vMAJOR.MINOR.PATCH");
	return {
		...stack,
		version: tag,
		hubs: Object.fromEntries(
			Object.entries(stack.hubs).map(([name, hub]) => [
				name,
				hub.version_override || pinnedOverlayRef(hub, stack.version)
					? hub
					: {
							...hub,
							repos: { ...hub.repos, ref: tag },
						},
			]),
		),
	};
}

/** The deployed ref is not necessarily the shared version: an overlay's
 * repos.ref can be a separate reviewed SHA or tag. */
export function hubDeployRef(
	hub: HubProfile,
	version: string | undefined,
): string {
	return resolveHubOrigin(hub, hub.version_override ?? version).ref;
}

export function releaseAvailable(
	current: string | undefined,
	latest: string,
): boolean {
	return !current || !parts(current) || compareReleaseTags(latest, current) > 0;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HUBCTL = join(HERE, "hubctl.ts");
const NOTICE_PATH = () =>
	join(homedir(), ".cache", "klh", "hub-update-last-notified");
const CHECK_PATH = () =>
	join(homedir(), ".cache", "klh", "hub-update-last-check");
const LOCK_PATH = () => join(homedir(), ".cache", "klh", "hub-update.lock");

/** One controller process can inspect or change hub pins at a time. */
export function withUpdateLock<T>(action: () => T, path = LOCK_PATH()): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let owner: number;
		try {
			owner = Number(readFileSync(join(path, "pid"), "utf8"));
		} catch {
			throw new Error(
				"hub update lock has no readable owner; inspect before clearing it",
			);
		}
		if (!Number.isSafeInteger(owner) || owner <= 0)
			throw new Error(
				"hub update lock has no valid owner; inspect before clearing it",
			);
		try {
			process.kill(owner, 0);
			throw new Error(`hub update already running (pid ${owner})`);
		} catch (probe) {
			if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
		}
		unlinkSync(join(path, "pid"));
		rmdirSync(path);
		mkdirSync(path, { mode: 0o700 });
	}
	writeFileSync(join(path, "pid"), `${process.pid}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	try {
		return action();
	} finally {
		unlinkSync(join(path, "pid"));
		rmdirSync(path);
	}
}

type CommandResult = { status: number | null; stdout: string; stderr: string };
type Run = (argv: string[], timeoutMs: number) => CommandResult;

const run: Run = (argv, timeoutMs) => {
	const result = spawnSync(argv[0] ?? "", argv.slice(1), {
		encoding: "utf8",
		timeout: timeoutMs,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
	};
};

/** The operator's configured deployment origin is the release source. A
 * mixed-origin fleet declares updates.origin explicitly. With no hub origin,
 * the managing checkout's git remote is the last fallback. */
export function releaseOriginOf(
	stack: StackConfig,
	checkoutOrigin?: string,
): string {
	if (stack.updates?.origin) return stack.updates.origin;
	const origins = [
		...new Set(
			Object.values(stack.hubs).flatMap((hub) =>
				[hub.repos?.buckle, hub.repos?.suspenders, hub.repos?.belt].filter(
					(value): value is string => !!value,
				),
			),
		),
	];
	if (origins.length === 1) return origins[0] ?? "";
	if (origins.length > 1)
		throw new Error(
			"multiple hub origins; set stack.json updates.origin explicitly",
		);
	if (checkoutOrigin) return checkoutOrigin;
	throw new Error("no release origin; set stack.json updates.origin");
}

function checkoutOrigin(execute: Run = run): string | undefined {
	const result = execute(["git", "remote", "get-url", "origin"], 10_000);
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

/** Discover stable Fleet tags. Failure is unknown, never an empty release
 * list that could accidentally trigger a downgrade. */
export function publishedRelease(origin: string, execute: Run = run): string {
	const result = execute(
		["git", "ls-remote", "--tags", "--refs", origin, "refs/tags/v*"],
		30_000,
	);
	if (result.status !== 0)
		throw new Error(
			`release origin unavailable (git exit ${result.status ?? "?"})`,
		);
	const tag = latestReleaseTag(result.stdout);
	if (!tag)
		throw new Error("release origin has no stable vMAJOR.MINOR.PATCH tag");
	return tag;
}

export function checkDue(
	nowMs: number,
	lastMs: number | null,
	intervalS: number,
): boolean {
	return (
		lastMs === null || lastMs > nowMs || nowMs - lastMs >= intervalS * 1000
	);
}

function lastCheck(): number | null {
	try {
		const value = Number(readFileSync(CHECK_PATH(), "utf8").trim());
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function stampCheck(nowMs: number): void {
	const path = CHECK_PATH();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}`;
	writeFileSync(temp, `${nowMs}\n`, { mode: 0o600, flag: "wx" });
	renameSync(temp, path);
}

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Read the ref the hub actually has in its deployed compose .env. */
export function installedHubRef(
	hub: HubProfile,
	execute: Run = run,
): string | null {
	const dir = hub.deploy?.dir;
	if (!dir) return null;
	const path = join(dir, ".env");
	try {
		if (!hub.deploy?.ssh) {
			const text = readFileSync(path, "utf8");
			return /^HUB_FLEET_REF=(.*)$/m.exec(text)?.[1]?.trim() ?? null;
		}
		const script = `awk -F= '$1=="HUB_FLEET_REF" {print $2; exit}' ${quote(path)}`;
		const result = execute(
			["ssh", ...sshOpts(hub), hub.deploy.ssh, script],
			30_000,
		);
		return result.status === 0 ? result.stdout.trim() || null : null;
	} catch {
		return null;
	}
}

export interface HubUpdateRow {
	hub: string;
	installed: string | null;
	pinned: string | null;
	latest: string;
	updateAvailable: boolean;
	deploymentDrift: boolean;
	canary: boolean;
	pinnedOverlay: boolean;
	autoUpdate: boolean;
}

/** One shared version can advance automatically only when every managed hub
 * consents. Explicit canaries retain their independently reviewed pin. */
export function automaticUpdatePolicy(stack: StackConfig): {
	ready: boolean;
	blocked: string[];
} {
	const managed = Object.entries(stack.hubs).filter(
		([, hub]) => !hub.version_override && !pinnedOverlayRef(hub, stack.version),
	);
	const blocked = managed
		.filter(([, hub]) => !(hub.auto_update ?? stack.updates?.mode === "latest"))
		.map(([name]) => name);
	return { ready: managed.length > 0 && blocked.length === 0, blocked };
}

export function updateRows(
	stack: StackConfig,
	latest: string,
	installed: (hub: HubProfile) => string | null = installedHubRef,
): HubUpdateRow[] {
	return Object.entries(stack.hubs).map(([name, hub]) => {
		const pin = hubDeployRef(hub, stack.version);
		const actual = installed(hub);
		const pinnedOverlay = pinnedOverlayRef(hub, stack.version);
		return {
			hub: name,
			installed: actual,
			pinned: pin ?? null,
			latest,
			updateAvailable:
				!hub.version_override &&
				!pinnedOverlay &&
				releaseAvailable(stack.version, latest),
			deploymentDrift: actual !== pin,
			canary: !!hub.version_override,
			pinnedOverlay,
			autoUpdate:
				!hub.version_override &&
				!pinnedOverlay &&
				(hub.auto_update ?? stack.updates?.mode === "latest"),
		};
	});
}

/** The 0600 machine file is a CAS write. No source ref or hub is touched
 * before every candidate pin has passed the same deploy ref preflight. */
function writeStack(path: string, expected: string, next: string): void {
	if (!existsSync(path))
		throw new Error("stack.json absent; run the install migration first");
	if ((statSync(path).mode & 0o777) !== 0o600)
		throw new Error("stack.json must be mode 0600 before update");
	if (readFileSync(path, "utf8") !== expected)
		throw new Error(
			"stack.json changed during update; retry from a fresh check",
		);
	const temp = `${path}.hub-update-${randomUUID()}`;
	writeFileSync(temp, next, { mode: 0o600, flag: "wx" });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

/** Compose can leave the old healthy container running after a failed
 * recreate. Check the live gateway's version, not merely the rendered .env. */
function activeHubRef(hub: HubProfile, execute: Run): string | null {
	const dir = hub.deploy?.dir;
	if (!dir) return null;
	const argv = [
		hub.deploy?.docker ?? "docker",
		"compose",
		"-f",
		join(dir, "hub-compose.yaml"),
		"--project-directory",
		dir,
		"exec",
		"-T",
		"buckle-hub",
		"printenv",
		"FLEET_VERSION",
	];
	const command = hub.deploy?.ssh
		? ["ssh", ...sshOpts(hub), hub.deploy.ssh, argv.map(quote).join(" ")]
		: argv;
	const result = execute(command, 30_000);
	return result.status === 0 ? result.stdout.trim() || null : null;
}

function deploy(
	name: string,
	hub: HubProfile,
	expected: string,
	execute: Run,
): boolean {
	const first = execute([process.execPath, HUBCTL, "deploy", name], 600_000);
	if (first.status === 0 && activeHubRef(hub, execute) === expected)
		return true;
	// Sidecars may still be starting when compose returns. Require a fresh
	// outside-process health verdict; a failed up cannot pass by timing alone.
	for (let attempt = 0; attempt < 3; attempt++) {
		Bun.sleepSync(5_000);
		const status = execute([process.execPath, HUBCTL, "status", name], 120_000);
		if (status.status === 0 && activeHubRef(hub, execute) === expected)
			return true;
	}
	// Deploy stderr may contain credential-bearing repository URLs.
	console.error(`hub ${name}: deploy failed (exit ${first.status ?? "?"})`);
	return false;
}

/** All hubs share one version. Preflight every origin, atomically pin it,
 * then deploy each hub. Any failed health verdict restores the old pin and
 * redeploys each changed hub to the known prior release. */
export function applyRelease(
	stack: StackConfig,
	tag: string,
	deps: {
		preflight?: (hub: HubProfile, name: string, version: string) => void;
		deployHub?: (name: string, expected: string) => boolean;
		installed?: (hub: HubProfile) => string | null;
		path?: string;
		quietHours?: (hub: HubProfile) => boolean;
	} = {},
): void {
	if (!stack.version)
		throw new Error("automatic hub update requires a pinned stack version");
	if (!releaseAvailable(stack.version, tag))
		throw new Error(
			`${tag} is not newer than ${stack.version ?? "the current pin"}`,
		);
	if (
		Object.values(stack.hubs).some((hub) =>
			(deps.quietHours ?? inQuietHours)(hub),
		)
	)
		throw new Error(
			"a hub is in quiet hours; update deferred until all hubs are available",
		);
	const candidate = stackAtRelease(stack, tag);
	const issues = stackConfIssues(candidate);
	if (issues.length > 0)
		throw new Error(`candidate stack config invalid: ${issues.join("; ")}`);
	for (const [name, hub] of Object.entries(stack.hubs)) {
		if (hub.version_override) continue;
		const actual = (deps.installed ?? installedHubRef)(hub);
		const expected = hubDeployRef(hub, stack.version);
		if (actual !== expected)
			throw new Error(
				`hub ${name} runs ${actual ?? "unknown"}, expected ${expected}; repair deployment drift before upgrading`,
			);
	}
	for (const [name, hub] of Object.entries(candidate.hubs))
		(deps.preflight ?? assertDeployRefsExist)(
			hub,
			name,
			hub.version_override ?? tag,
		);
	const path = deps.path ?? STACK_PATH();
	const before = readFileSync(path, "utf8");
	const after = `${JSON.stringify(candidate, null, 2)}\n`;
	const backup = `${path}.before-hub-update-${randomUUID()}`;
	writeFileSync(backup, before, { mode: 0o600, flag: "wx" });
	chmodSync(backup, 0o600);
	writeStack(path, before, after);
	const deployOne =
		deps.deployHub ??
		((name: string, expected: string) => {
			const hub = candidate.hubs[name];
			return !!hub && deploy(name, hub, expected, run);
		});
	const changed = Object.keys(stack.hubs).filter((name) => {
		const beforeHub = stack.hubs[name];
		const afterHub = candidate.hubs[name];
		return (
			!!beforeHub &&
			!!afterHub &&
			hubDeployRef(beforeHub, stack.version) !== hubDeployRef(afterHub, tag)
		);
	});
	let failed = false;
	for (const name of changed) {
		const hub = candidate.hubs[name];
		if (!hub) throw new Error(`candidate hub ${name} missing`);
		const expected = hubDeployRef(hub, tag);
		console.log(`updating ${name} to ${expected}`);
		if (!deployOne(name, expected)) {
			failed = true;
			break;
		}
	}
	if (!failed) {
		unlinkSync(backup);
		return;
	}
	writeStack(path, after, before);
	const rollbackFailed: string[] = [];
	for (const name of changed) {
		const hub = stack.hubs[name];
		const expected = hub ? hubDeployRef(hub, stack.version) : stack.version;
		console.error(`rolling back ${name} to ${expected}`);
		if (!deployOne(name, expected)) rollbackFailed.push(name);
	}
	if (rollbackFailed.length === 0) unlinkSync(backup);
	throw new Error(
		rollbackFailed.length > 0
			? `update failed; old pin restored but rollback health failed on ${rollbackFailed.join(", ")}; backup ${backup}`
			: "update failed; old pin and hub health restored",
	);
}

export function notifyAvailable(
	tag: string,
	execute: Run = run,
	marker: string = NOTICE_PATH(),
	message?: string,
): void {
	try {
		if (readFileSync(marker, "utf8").trim() === tag) return;
	} catch {
		// first new release
	}
	const note =
		message ??
		`Fleet ${tag} is available for configured hubs. Review with bun packages/suspenders/deploy/hub-update.ts check, then install with bun packages/suspenders/deploy/hub-update.ts apply --yes, or set stack.json updates.mode=latest.`;
	const result = execute(
		[
			process.execPath,
			join(HERE, "../hooks/bin/coord.ts"),
			"emit",
			"NEED_DECISION",
			"--scope",
			"suspenders",
			"--as",
			"hub-update-check",
			"--note",
			note,
		],
		30_000,
	);
	if (result.status !== 0)
		throw new Error(
			"could not deliver the update decision; will retry next cycle",
		);
	mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
	const temp = `${marker}.${randomUUID()}`;
	writeFileSync(temp, `${tag}\n`, { mode: 0o600, flag: "wx" });
	renameSync(temp, marker);
}

function repairDrift(stack: StackConfig, rows: HubUpdateRow[]): void {
	for (const row of rows.filter((item) => item.deploymentDrift)) {
		const hub = stack.hubs[row.hub];
		const pin = row.pinned;
		if (!hub || !pin)
			throw new Error(`hub ${row.hub} has no pinned release to restore`);
		if (inQuietHours(hub))
			throw new Error(`hub ${row.hub} is in quiet hours; repair deferred`);
		assertDeployRefsExist(hub, row.hub, pin);
		console.log(`repairing ${row.hub}: ${row.installed ?? "unknown"} → ${pin}`);
		if (!deploy(row.hub, hub, pin, run))
			throw new Error(`hub ${row.hub} remains unhealthy at ${pin}`);
	}
}

function main(): void {
	const [verb, ...flags] = process.argv.slice(2);
	if (!verb || !["check", "apply", "reconcile"].includes(verb)) {
		console.log(
			"usage: hub-update check [--json] | apply --yes [--to vMAJOR.MINOR.PATCH] | reconcile",
		);
		process.exit(verb ? 2 : 0);
	}
	const stack = loadStack();
	const nowMs = Date.now();
	if (
		verb === "reconcile" &&
		!flags.includes("--force") &&
		!checkDue(nowMs, lastCheck(), stack.updates?.check_interval_s ?? 300)
	)
		return;
	const latest = publishedRelease(releaseOriginOf(stack, checkoutOrigin()));
	const rows = updateRows(stack, latest);
	const policy = automaticUpdatePolicy(stack);
	if (verb === "check") {
		if (flags.includes("--json"))
			console.log(
				JSON.stringify({ mode: stack.updates?.mode ?? "manual", policy, rows }),
			);
		else
			for (const row of rows)
				console.log(
					`${row.hub}: installed=${row.installed ?? "unknown"} pinned=${row.pinned ?? "unknown"} latest=${latest}${row.canary ? " (canary pinned)" : row.pinnedOverlay ? " (overlay ref pinned)" : row.deploymentDrift ? " — deployment drift" : row.updateAvailable ? " — update available" : " — current"} auto_update=${row.autoUpdate}`,
				);
		if (!flags.includes("--json") && rows.some((row) => row.updateAvailable))
			console.log(
				"Install after review: bun packages/suspenders/deploy/hub-update.ts apply --yes",
			);
		if (!flags.includes("--json") && rows.some((row) => row.deploymentDrift))
			console.log(
				"Repair before upgrade: hubctl deploy <hub> (reconcile repairs automatically only when every managed hub permits auto-update)",
			);
		return;
	}
	const drift = rows.filter((row) => row.deploymentDrift);
	if (drift.length > 0 && verb === "reconcile") {
		if (policy.ready) repairDrift(stack, drift);
		else {
			const names = drift.map((row) => row.hub).join(", ");
			notifyAvailable(
				`drift:${stack.version ?? "unknown"}:${names}`,
				run,
				NOTICE_PATH(),
				`Fleet hub deployment drift on ${names}; review hub-update check, then repair with hubctl deploy <hub> before upgrading.`,
			);
			console.log(`hub deployment drift on ${names}; decision requested`);
			stampCheck(nowMs);
			return;
		}
	}
	if (!rows.some((row) => row.updateAvailable)) {
		if (verb === "apply" && drift.length > 0)
			throw new Error(
				"deployment drift must be repaired with hubctl deploy <hub> before applying a new release",
			);
		console.log(`Fleet ${stack.version ?? "unversioned"} is current`);
		if (verb === "reconcile") stampCheck(nowMs);
		return;
	}
	if (verb === "reconcile" && !policy.ready) {
		const hold = policy.blocked.length
			? ` Automatic rollout is held because ${policy.blocked.join(", ")} have not enabled auto_update; the shared stack version advances together.`
			: "";
		notifyAvailable(
			latest,
			run,
			NOTICE_PATH(),
			`Fleet ${latest} is available for configured hubs.${hold} Review with bun packages/suspenders/deploy/hub-update.ts check, then install with bun packages/suspenders/deploy/hub-update.ts apply --yes, or enable auto_update for every managed hub.`,
		);
		console.log(`Fleet ${latest} available; decision requested`);
		stampCheck(nowMs);
		return;
	}
	if (verb === "apply" && !flags.includes("--yes"))
		throw new Error("review the check result, then pass --yes to apply");
	const to = flags.includes("--to") ? flags[flags.indexOf("--to") + 1] : latest;
	if (!to || to !== latest)
		throw new Error(`only latest published release ${latest} can be applied`);
	applyRelease(stack, to);
	console.log(`Fleet ${to} healthy on all release-tracking hubs`);
	if (verb === "reconcile") stampCheck(nowMs);
}

if (import.meta.main) {
	try {
		withUpdateLock(main);
	} catch (error) {
		console.error(
			`hub-update: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
