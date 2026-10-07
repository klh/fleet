// scripts/install-launchd.ts — the W490.2 registerLaunchd step body: renders
// the fleet service manifest through scripts/install-services.ts (execa — the
// SAME emitters W488 landed) into ~/Library/LaunchAgents with install.sh's
// exact substitution defaults (command -v bun, $HOME, prefix, repo; BELT_URL /
// BELT_TOKEN ride process env exactly as the sed pass reads them), loads each
// unit via scripts/load-launchd.sh, and supersedes the pre-namespacing
// com.klh.* labels. Non-darwin: a no-op ("skipped"), matching install.sh's
// "--with-launchd skipped (not macOS)".
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import {
	digestUnit,
	readActivation,
	retainActivation,
	writeActivation,
	type ActivationReceipt,
	type ActivationService,
} from "./lib/service-drift.ts";
import type { StepContext, StepResult } from "./install-run.ts";

// supersede the pre-namespacing agent labels so old and new never run side by
// side (same jobs, stale script paths, double keepwarm/monitor pings)
export const LEGACY_LABELS = [
	"com.klh.llm-keepwarm",
	"com.klh.fleet-monitor",
	"com.klh.local-llm",
] as const;

// W427: a unit rendered from a linked git worktree pins the agent to a
// reapable tree (the spoke served from a codex demo worktree until its plist
// was re-rendered from the pinned checkout). .git as a FILE is the
// linked-worktree marker; a main checkout has the .git DIR and the installed
// harness copy has no .git at all.
export function pinnedCheckoutRefusal(repo: string): string | null {
	const gitPath = join(repo, ".git");
	let stat;
	try {
		stat = statSync(gitPath);
	} catch {
		return null; // no .git — installed harness copy, not a worktree
	}
	if (!stat.isDirectory()) {
		return `${gitPath} is a file — ${repo} is a linked git worktree, not a pinned stack checkout; launchd units must not point into a reapable tree (run install.sh from the pinned checkout)`;
	}
	return null;
}

export async function registerLaunchd(ctx: StepContext): Promise<StepResult> {
	if (process.platform !== "darwin") {
		return {
			status: "skipped",
			note: "not macOS — launchd agents not registered (matches install.sh)",
		};
	}
	const refusal = pinnedCheckoutRefusal(ctx.repo);
	if (refusal !== null) {
		return { status: "failed", note: refusal };
	}
	const home = process.env.HOME ?? "";
	const agentsDir = join(home, "Library", "LaunchAgents");
	const insightsDir = join(home, ".claude-insights");
	// W264: agent logs live in the private insights dir, never world-readable /tmp
	mkdirSync(insightsDir, { recursive: true, mode: 0o700 });
	chmodSync(insightsDir, 0o700);
	const bun = Bun.which("bun");
	if (bun === null) {
		return {
			status: "failed",
			note: "bun is not on PATH — cannot render services",
		};
	}
	const renderer = join(ctx.repo, "scripts/install-services.ts");
	const res = await execa(
		process.execPath,
		[
			renderer,
			"--target",
			"darwin",
			"--out",
			agentsDir,
			"--json",
			"--bun",
			bun,
			"--home",
			home,
			"--prefix",
			ctx.prefix,
			"--repo",
			ctx.repo,
		],
		{ cwd: ctx.repo, stderr: "inherit" },
	);
	const rendered = JSON.parse(res.stdout) as {
		services: Array<{ service: string; files: string[]; port?: number }>;
	};
	const plists = rendered.services.flatMap((s) =>
		s.files.filter((f) => f.endsWith(".plist")),
	);
	const failed: string[] = [];
	const activated: ActivationService[] = [];
	const ports = JSON.parse(
		process.env.SUSPENDERS_SERVICE_PORTS_JSON ?? "{}",
	) as Record<string, number>;
	// W546: the manifest may declare a listener port (buckle-spoke :4101) —
	// the receipt records it so supervision lsof-verifies the LISTENER, not
	// just the PID. A machine-level env override wins over the declaration.
	const declaredPorts = new Map(
		rendered.services.flatMap((s) =>
			s.port === undefined ? [] : [[`com.suspenders.${s.service}`, s.port]],
		),
	);
	if (
		Object.values(ports).some(
			(port) => !Number.isInteger(port) || port < 1 || port > 65535,
		)
	)
		throw new Error("Invalid machine service port mapping");
	for (const file of plists) {
		const label = file.replace(/\.plist$/, "");
		const unit = join(agentsDir, file);
		const log = join(insightsDir, `launchd-${label}.log`);
		// load-launchd.sh: plutil -lint, bootout, bootstrap, print — per-unit
		// diagnostics land in the insights log, never the installer's stdout
		const load = await execa(
			"bash",
			[join(ctx.repo, "scripts/load-launchd.sh"), unit, log],
			{ reject: false, stdout: "pipe", stderr: "pipe" },
		);
		if (load.exitCode !== 0) failed.push(label);
		else {
			try {
				const parsed = await execa(
					"/usr/bin/plutil",
					["-convert", "json", "-o", "-", unit],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const definition = JSON.parse(parsed.stdout) as {
					ProgramArguments: string[];
					KeepAlive?: boolean;
				};
				// machine env override wins, else the manifest declaration
				const port = ports[label] ?? declaredPorts.get(label);
				activated.push({
					label,
					unit,
					unitSha256: digestUnit(readFileSync(unit)),
					arguments: definition.ProgramArguments,
					resident: definition.KeepAlive === true,
					...(port === undefined ? {} : { port }),
				});
			} catch {
				failed.push(label);
			}
		}
	}
	// Record only successful explicit registration attempts; generated files alone are not activation.
	const receipt: ActivationReceipt = {
		schema: "fleet.service-activation.v1",
		platform: "darwin",
		domain: `gui/${process.getuid()}`,
		manifest: join(ctx.repo, "deploy/services.yaml"),
		manifestSha256: digestUnit(
			readFileSync(join(ctx.repo, "deploy/services.yaml")),
		),
		services: activated,
	};
	const receiptPath = join(home, ".config/klh/service-activation.json");
	let previous: ActivationReceipt | undefined;
	try {
		previous = readActivation(receiptPath);
	} catch {
		/* Unknown or absent intent is never invented. */
	}
	writeActivation(receiptPath, retainActivation(receipt, previous));
	const superseded: string[] = [];
	for (const legacy of LEGACY_LABELS) {
		await execa("launchctl", ["bootout", `gui/${process.getuid()}/${legacy}`], {
			reject: false,
			stdout: "pipe",
			stderr: "pipe",
		});
		const legacyPlist = join(agentsDir, `${legacy}.plist`);
		if (existsSync(legacyPlist)) {
			rmSync(legacyPlist);
			superseded.push(legacy);
		}
	}
	if (failed.length > 0) {
		return {
			status: "failed",
			note: `launchd jobs failed: ${failed.join(" ")}`,
			detail: `diagnostics: ${join(insightsDir, "launchd-<label>.log")}`,
		};
	}
	return {
		status: "ok",
		note: `${rendered.services.length} launchd agents rendered via install-services.ts and loaded`,
		detail: `${agentsDir} — from deploy/services.yaml; legacy labels superseded: ${superseded.length > 0 ? superseded.join(" ") : "none"}`,
	};
}
