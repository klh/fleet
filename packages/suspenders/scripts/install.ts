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
//   bun scripts/install.ts --yes                # consented run (legacy blocks via install.sh __legacy full)
//
// Exit codes: 0 ok/pause (need_user_action), 1 failure, 2 usage error.
import meow from "meow";
import ora, { type Ora } from "ora";
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
  --yes           Unattended consent (legacy blocks run via install.sh __legacy full)
  --verbose       Per-step detail and resolved paths
  --step <name>   Run one step by frozen name (contract.steps[].name)

Exit codes
  0 ok/pause   1 failure   2 usage

The machine-readable contract (contractVersion 1) is embedded in every --json outcome.
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
		step: null,
	};
	if (parsed.error !== undefined) {
		const doc = usageOutcome(parsed.error, flags);
		if (flags.json) console.log(JSON.stringify(doc, null, "\t"));
		else console.log(`usage error: ${parsed.error} — try --help`);
		process.exitCode = 2;
		return;
	}
	const ctx: StepContext = {
		dryRun: flags.dryRun,
		yes: flags.yes,
		json: flags.json,
		verbose: flags.verbose,
		...resolvePaths(),
	};
	const mode: "plan" | "step" = flags.step === null ? "plan" : "step";
	let spinner: Ora | null = null;
	if (!flags.json) spinner = ora("suspenders install").start();
	const executed = await executePlan(mode, flags.step, ctx, () => {});
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
	process.exitCode = exitFor(doc.outcome);
}

if (import.meta.main) {
	await main();
}
