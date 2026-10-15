// scripts/install-cli.ts — flag parsing/validation + human rendering for the
// W490.1 installer CLI (scripts/install.ts). The contract
// (scripts/install-contract.ts) is the frozen surface; this module owns the
// CLI-side seams the drift tests check (meowFlags, step names).
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentNextStep,
	INSTALL_CONTRACT,
	type InstallOutcome,
	type OutcomeStatus,
	type PauseRow,
	type StepStatus,
} from "./install-contract.ts";

/** Frozen flag definitions — must equal INSTALL_CONTRACT.flags (drift-tested). */
export const meowFlags = {
	dryRun: { type: "boolean" },
	json: { type: "boolean" },
	yes: { type: "boolean" },
	verbose: { type: "boolean" },
	wire: { type: "boolean" },
	step: { type: "string" },
	wireRepo: { type: "string" },
	gatewayReview: { type: "string" },
	profile: { type: "string" },
	prune: { type: "boolean" },
	skipModels: { type: "boolean" },
	noLlm: { type: "boolean" },
	hub: { type: "string" },
	withLaunchd: { type: "boolean" },
	reBlessActivation: { type: "boolean" },
	confirm: { type: "string" },
} as const;

export interface ResolvedFlags {
	dryRun: boolean;
	json: boolean;
	yes: boolean;
	verbose: boolean;
	wire: boolean;
	step: string | null;
	wireRepo: string | null;
	gatewayReview?: string;
	profile: "hub" | "spoke";
	prune: boolean;
	skipModels: boolean;
	noLlm: boolean;
	hub: string | null;
	withLaunchd: boolean;
	reBlessActivation: boolean;
	confirm: string | null;
}

export function resolvePaths(): {
	repo: string;
	prefix: string;
	shimBin: string;
	llmHome: string;
	home: string;
} {
	const home = process.env.HOME ?? homedir();
	return {
		repo: join(import.meta.dir, ".."),
		prefix: process.env.SUSPENDERS_PREFIX ?? `${home}/.claude/hooks/suspenders`,
		shimBin: process.env.SUSPENDERS_SHIM_BIN ?? `${home}/.local/bin`,
		llmHome: `${home}/.claude/local-llm`,
		home,
	};
}

export function knownStepNames(): string[] {
	return INSTALL_CONTRACT.steps.map((s) => s.name);
}

/** Validate meow's loose flags record against the frozen contract surface. */
export function parseFlags(
	raw: Record<string, unknown>,
	input: string[],
): {
	error?: string;
	flags?: ResolvedFlags;
} {
	const bool = (key: string): boolean => raw[key] === true;
	const step =
		typeof raw.step === "string" && raw.step.trim() !== "" ? raw.step : null;
	const wire = bool("wire");
	const wireRepo =
		typeof raw.wireRepo === "string" && raw.wireRepo.trim() !== ""
			? raw.wireRepo
			: null;
	const rawProfile = raw.profile;
	const profile =
		rawProfile === "spoke" || rawProfile === "hub" ? rawProfile : undefined;
	const effectiveStep = wire && step === null ? "wireSettings" : step;
	const hub =
		typeof raw.hub === "string" && raw.hub.trim() !== "" ? raw.hub : null;
	const confirm =
		typeof raw.confirm === "string" && raw.confirm.trim() !== ""
			? raw.confirm
			: null;
	const flags: ResolvedFlags = {
		dryRun: bool("dryRun"),
		json: bool("json"),
		yes: bool("yes") || wire,
		verbose: bool("verbose"),
		wire,
		step: effectiveStep,
		wireRepo,
		profile: profile ?? "hub",
		prune: bool("prune"),
		skipModels: bool("skipModels"),
		noLlm: bool("noLlm"),
		hub,
		withLaunchd: bool("withLaunchd"),
		reBlessActivation: bool("reBlessActivation"),
		confirm,
		...(typeof raw.gatewayReview === "string"
			? { gatewayReview: raw.gatewayReview }
			: {}),
	};
	const known = Object.keys(meowFlags);
	const unknown = Object.keys(raw).filter((k) => !known.includes(k));
	if (unknown.length > 0) {
		return { error: `unknown flag --${unknown[0] ?? ""}`, flags };
	}
	if (
		rawProfile !== undefined &&
		rawProfile !== "hub" &&
		rawProfile !== "spoke"
	) {
		return { error: "--profile requires hub|spoke", flags };
	}
	if (raw.hub !== undefined && hub === null) {
		return {
			error: "--hub needs a hub name from ~/.config/klh/stack.yaml",
			flags,
		};
	}
	if (raw.confirm !== undefined && confirm === null) {
		return {
			error:
				"--confirm needs a manifest sha prefix (>=12 hex of the NEW candidate)",
			flags,
		};
	}
	if (confirm !== null && !flags.reBlessActivation) {
		return {
			error: "--confirm is only valid with --re-bless-activation",
			flags,
		};
	}
	if (input.length > 0) {
		return {
			error: `unexpected positional argument "${input[0] ?? ""}"`,
			flags,
		};
	}
	if (raw.step !== undefined && step === null) {
		return { error: "--step requires a step name", flags };
	}
	if (step !== null && !knownStepNames().includes(step)) {
		return {
			error: `unknown step "${step}" — documented names: ${knownStepNames().join(", ")}`,
			flags,
		};
	}
	if (wire && step !== null && step !== "wireSettings") {
		return {
			error: "--wire is only valid with --step wireSettings",
			flags,
		};
	}
	if (wireRepo !== null && effectiveStep !== "wireSettings") {
		return {
			error: "--wire-repo is only valid with --step wireSettings",
			flags,
		};
	}
	if (
		raw.gatewayReview !== undefined &&
		(typeof raw.gatewayReview !== "string" ||
			!/^[a-f0-9]{64}$/.test(raw.gatewayReview) ||
			step !== "upgradeGateway")
	)
		return {
			error: "--gateway-review requires a SHA256 and --step upgradeGateway",
			flags,
		};
	return { flags };
}

/** agent_next_steps hypermedia — single-use actions, frozen field names. */
export function nextSteps(
	outcome: OutcomeStatus,
	pauses: PauseRow[],
	mode: "plan" | "step",
	dryRun: boolean,
): AgentNextStep[] {
	const invoker = process.argv[1] ?? "bun scripts/install.ts";
	const steps: AgentNextStep[] = [];
	for (const p of pauses) {
		steps.push({
			action: "resume",
			command: p.resume_command,
			note: `${p.step}: ${p.reason}`,
		});
	}
	if (outcome === "usage_error") {
		steps.push({
			action: "help",
			command: `${invoker} --help`,
			note: "accepted flags also live in contract.flags",
		});
		steps.push({
			action: "list-steps",
			command: `${invoker} --json --dry-run`,
			note: "contract.steps[].name are the --step tokens",
		});
	}
	if (outcome === "failed") {
		steps.push({
			action: "inspect",
			command: `${invoker} --json --dry-run`,
			note: "re-inspect the plan before retrying",
		});
	}
	if (dryRun && outcome === "ok") {
		steps.push({
			action: "execute",
			command: `${invoker} --json --yes`,
			note: "the consented run",
		});
	}
	if (!dryRun && outcome === "ok" && pauses.length === 0 && mode === "plan") {
		steps.push({
			action: "post-install",
			command: "restart Claude Code so the hooks register (human action)",
			note: "then inspect: bun $PREFIX/bin/fleet-board.ts",
		});
	}
	return steps;
}

export function outcomeGlyph(outcome: OutcomeStatus): string {
	switch (outcome) {
		case "ok":
			return "✓";
		case "need_user_action":
			return "·";
		default:
			return "✗";
	}
}

export function stepGlyph(status: StepStatus): string {
	switch (status) {
		case "ok":
			return "✓";
		case "failed":
			return "✗";
		default:
			return "·";
	}
}

export function exitFor(outcome: OutcomeStatus): number {
	switch (outcome) {
		case "ok":
		case "need_user_action":
			return 0;
		case "failed":
			return 1;
		default:
			return 2;
	}
}

/** The frozen usage-error outcome (exit 2) — same schema, agent_next_steps attached. */
export function usageOutcome(
	msg: string,
	flags: ResolvedFlags,
): InstallOutcome {
	const doc: InstallOutcome = {
		schema: "suspenders.install.v1",
		contractVersion: INSTALL_CONTRACT.contractVersion,
		ok: false,
		outcome: "usage_error",
		mode: "plan",
		flags,
		paths: resolvePaths(),
		steps: [],
		pauses: [],
		agent_next_steps: nextSteps("usage_error", [], "plan", flags.dryRun),
		contract: INSTALL_CONTRACT,
	};
	doc.error = msg;
	return doc;
}

export function renderHuman(doc: InstallOutcome): void {
	console.log(
		`suspenders install — ${doc.mode}${doc.flags.dryRun ? " (dry-run)" : ""} — outcome: ${doc.outcome}`,
	);
	for (const row of doc.steps) {
		console.log(`  ${stepGlyph(row.status)} ${row.name} — ${row.note}`);
		if (doc.flags.verbose && row.detail !== undefined) {
			console.log(`      ${row.detail}`);
		}
	}
	for (const p of doc.pauses) {
		console.log(`    resume: ${p.resume_command}`);
	}
	for (const s of doc.agent_next_steps) {
		console.log(`  next: [${s.action}] ${s.command}`);
	}
}
