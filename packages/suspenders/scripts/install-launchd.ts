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

// supersede the pre-namespacing agent labels + the per-repo belt/local plists
// (W389 folded them into the manifest) so old and new never run side by side
// (same jobs, stale script paths, double :7791/:7792/:8912 supervision)
export const LEGACY_LABELS = [
	"com.klh.llm-keepwarm",
	"com.klh.fleet-monitor",
	"com.klh.local-llm",
	"com.belt.dashboard",
	"com.belt.swarm",
	"com.belt.kev",
	"com.klh-local.dashboard",
] as const;

export async function registerLaunchd(ctx: StepContext): Promise<StepResult> {
	if (process.platform !== "darwin") {
		return {
			status: "skipped",
			note: "not macOS — launchd agents not registered (matches install.sh)",
		};
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
		services: Array<{ service: string; files: string[] }>;
	};
	const plists = rendered.services.flatMap((s) =>
		s.files.filter((f) => f.endsWith(".plist")),
	);
	const failed: string[] = [];
	const activated: ActivationService[] = [];
	const ports = JSON.parse(
		process.env.SUSPENDERS_SERVICE_PORTS_JSON ?? "{}",
	) as Record<string, number>;
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
				activated.push({
					label,
					unit,
					unitSha256: digestUnit(readFileSync(unit)),
					arguments: definition.ProgramArguments,
					resident: definition.KeepAlive === true,
					...(ports[label] === undefined ? {} : { port: ports[label] }),
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
