#!/usr/bin/env bun
// scripts/install.ts — the bun-native, LLM-drivable installer entry (W490.1).
// Skeleton + machine contract this child; internals land in W488.1/W490.2.
// Modules: install-contract.ts (frozen surface) · install-run.ts (plan runner
// + v1 impls) · install-cli.ts (parsing/validation/rendering). The contract is
// the single source the CLI and the tests drift-check.
//
//   bun scripts/install.ts --json --dry-run     # plan, zero side effects
//   bun scripts/install.ts --json               # outcome + contract (stdout)
//   bun scripts/install.ts --step <name>        # one step (frozen names)
//   bun scripts/install.ts --yes                # consented run (every step native since W771.3)
//
// Exit codes: 0 ok/pause (need_user_action), 1 failure, 2 usage error.
import meow from "meow";
import ora, { type Ora } from "ora";
import { join } from "node:path";
import { INSTALL_CONTRACT, type InstallOutcome } from "./install-contract.ts";
import {
	exitFor,
	meowFlags,
	nextSteps,
	outcomeGlyph,
	parseFlags,
	renderHuman,
	resolvePaths,
	usageOutcome,
	type ResolvedFlags,
} from "./install-cli.ts";
import { executePlan, type StepContext } from "./install-run.ts";

const HELP = `
Usage
  $ bun scripts/install.ts [<options>]

Options
  --dry-run       Print the plan, zero side effects
  --json          Machine output: one JSON outcome document on stdout
  --yes           Unattended consent (every step native since W771.3)
  --verbose       Per-step detail and resolved paths
  --gateway-review <sha>  Approve the staged gateway upgrade candidate
  --step <name>   Run one step by frozen name (contract.steps[].name)
  --profile <p>   hub (default) = full; spoke ships no auth issuance/identity/key-custody code (W165)
  --wire          Merge hooks into ~/.claude/settings.json (+ adapters, gate wires)
  --wire-repo <path>  With --step wireSettings: wire a repo's project settings
  --prune         Mirror-mode sync — drop unmanaged prefix entries (W420)
  --skip-models   Skip the model download (offline installs)
  --no-llm        Skip the local-llm baseline (CI/containers)
  --with-launchd  Full plan, then registerLaunchd
  --hub <name>    Hub deploy from ~/.config/klh/stack.yaml (--dry-run renders the .env)
  --re-bless-activation [--confirm <sha>]  Owner-gated receipt re-bless (W640)

Exit codes
  0 ok/pause   1 failure   2 usage

The machine-readable contract (contractVersion 2) is embedded in every --json outcome.
`;

async function main(): Promise<void> {
	const cli = meow(HELP, {
		importMeta: import.meta,
		flags: meowFlags,
		allowUnknownFlags: true,
	});
	const parsed = parseFlags(
		cli.flags as unknown as Record<string, unknown>,
		cli.input,
	);
	const flags: ResolvedFlags = parsed.flags ?? {
		dryRun: false,
		json: false,
		yes: false,
		verbose: false,
		wire: false,
		step: null,
		wireRepo: null,
		profile: "hub",
		prune: false,
		skipModels: false,
		noLlm: false,
		hub: null,
		withLaunchd: false,
		reBlessActivation: false,
		confirm: null,
	};
	if (parsed.error !== undefined) {
		const doc = usageOutcome(parsed.error, flags);
		if (flags.json) console.log(JSON.stringify(doc, null, "\t"));
		else console.log(`usage error: ${parsed.error} — try --help`);
		process.exitCode = 2;
		return;
	}
	const paths = resolvePaths();
	const ctx: StepContext = {
		dryRun: flags.dryRun,
		yes: flags.yes,
		json: flags.json,
		verbose: flags.verbose,
		wireRepo: flags.wireRepo,
		gatewayReview: flags.gatewayReview,
		profile: flags.profile,
		prune: flags.prune,
		skipModels: flags.skipModels,
		noLlm: flags.noLlm,
		...paths,
	};
	// W771.3: the bash front's targeted routes absorbed as early exits —
	// --hub and --re-bless-activation (exec exit code propagates).
	// W284: --refresh-gateway retired with the local-llm serve fork it patched.
	const childRun = async (args: string[]): Promise<number> => {
		const child = Bun.spawn([process.execPath, ...args], {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		return await child.exited;
	};
	if (flags.hub !== null) {
		process.exitCode = await childRun([
			join(paths.repo, "deploy/hubctl.ts"),
			flags.dryRun ? "render" : "deploy",
			flags.hub,
		]);
		return;
	}
	if (flags.reBlessActivation) {
		process.exitCode = await childRun([
			join(paths.repo, "scripts/rebless-activation.ts"),
			"--re-bless-activation",
			...(flags.confirm !== null ? ["--confirm", flags.confirm] : []),
		]);
		return;
	}
	const mode: "plan" | "step" = flags.step === null ? "plan" : "step";
	let spinner: Ora | null = null;
	if (!flags.json) spinner = ora("suspenders install").start();
	const executed = await executePlan(mode, flags.step, ctx, () => {});
	// --with-launchd: the bash front's posture — full plan, then registerLaunchd
	// (bash parity: launchd only ran when the plan outcome wasn't failed)
	if (flags.withLaunchd && mode === "plan" && executed.outcome !== "failed") {
		const launchd = await executePlan("step", "registerLaunchd", ctx, () => {});
		executed.rows.push(...launchd.rows);
		executed.pauses.push(...launchd.pauses);
		if (launchd.outcome === "failed") executed.outcome = "failed";
	}
	spinner?.stopAndPersist({
		symbol: outcomeGlyph(executed.outcome),
		text: `done — ${executed.outcome}`,
	});
	const doc: InstallOutcome = {
		schema: "suspenders.install.v1",
		contractVersion: INSTALL_CONTRACT.contractVersion,
		ok: executed.outcome === "ok" || executed.outcome === "need_user_action",
		outcome: executed.outcome,
		mode,
		flags,
		paths: resolvePaths(),
		steps: executed.rows,
		pauses: executed.pauses,
		agent_next_steps: nextSteps(
			executed.outcome,
			executed.pauses,
			mode,
			flags.dryRun,
		),
		contract: INSTALL_CONTRACT,
	};
	if (flags.json) {
		console.log(JSON.stringify(doc, null, "\t"));
	} else {
		renderHuman(doc);
	}
	// W892/W899 (owner GO 2026-10-19): every install ends with the supervisor
	// micro-metrics table - the install itself proves the reporter is live.
	if (!flags.json && !flags.dryRun) {
		const rep = Bun.spawnSync(
			[
				"bun",
				new URL("../hooks/bin/fleet-report.ts", import.meta.url).pathname,
			],
			{ stdout: "inherit", stderr: "inherit" },
		);
		if (rep.exitCode !== 0)
			console.log(`(fleet-report unavailable: exit ${String(rep.exitCode)})`);
	}
	process.exitCode = exitFor(doc.outcome);
}

if (import.meta.main) {
	await main();
}
