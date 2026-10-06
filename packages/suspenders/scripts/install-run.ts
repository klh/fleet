// scripts/install-run.ts — the W490.1 install plan runner: v1 step
// implementations (only "real" steps live here), the bash delegation, the
// pause builder, and executePlan. Pure logic — no CLI parsing, no printing.
// The contract (scripts/install-contract.ts) is the frozen surface.
import { join } from "node:path";
import { execa } from "execa";
import {
	type ContractStep,
	INSTALL_CONTRACT,
	type OutcomeStatus,
	type PauseRow,
	type StepName,
	type StepOutcomeRow,
	type StepStatus,
} from "./install-contract.ts";

export interface StepContext {
	dryRun: boolean;
	yes: boolean;
	json: boolean;
	verbose: boolean;
	repo: string;
	prefix: string;
	shimBin: string;
	llmHome: string;
}

export interface StepResult {
	status: StepStatus;
	note: string;
	detail?: string;
}

export interface Executed {
	rows: StepOutcomeRow[];
	pauses: PauseRow[];
	outcome: OutcomeStatus;
}

export type RowSink = (row: StepOutcomeRow) => void;

type StepImpl = (ctx: StepContext) => Promise<StepResult>;

// ─── v1 step implementations (only "real" steps live here; the rest delegate) ───

async function probeEnvironment(): Promise<StepResult> {
	const bunPath = Bun.which("bun");
	if (bunPath === null) {
		return {
			status: "failed",
			note: "bun is not on PATH — install bun first (https://bun.sh)",
		};
	}
	return {
		status: "ok",
		note: "bun present",
		detail: `bun ${Bun.version} at ${bunPath} on ${process.platform}/${process.arch}`,
	};
}

async function refreshDashboards(ctx: StepContext): Promise<StepResult> {
	const script = join(ctx.repo, "scripts/refresh-dashboards.ts");
	const res = await execa(process.execPath, [script], {
		cwd: ctx.repo,
		stdout: "pipe",
		stderr: "inherit",
	});
	const text = typeof res.stdout === "string" ? res.stdout : "";
	const tail = text.trim().split("\n").at(-1) ?? "";
	return {
		status: "ok",
		note: "belt dashboards refreshed",
		detail: `${script}${tail === "" ? "" : ` — ${tail}`}`,
	};
}

/**
 * The v1 delegation: one bash install.sh invocation covers every mutating
 * "delegated" step on a consented full run (replaced in W488.1/W490.2).
 */
async function delegateBash(
	ctx: StepContext,
): Promise<{ ok: boolean; note: string; detail: string }> {
	const script = join(ctx.repo, "install.sh");
	try {
		const res = await execa("bash", [script], {
			cwd: ctx.repo,
			stdout: ctx.json ? "pipe" : "inherit",
			stderr: "inherit",
		});
		const text = typeof res.stdout === "string" ? res.stdout : "";
		const tail = text.trim().split("\n").at(-1) ?? "";
		return {
			ok: true,
			note: "executed via the v1 bash delegation (install.sh)",
			detail: tail,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, note: `bash delegation failed — ${msg}`, detail: "" };
	}
}

// ─── pause states (first-class: resume_command, never a blocking prompt) ───

function resumeCommand(step: ContractStep, ctx: StepContext): string {
	if (step.name === "refreshDashboards") {
		return `bun ${join(ctx.repo, "scripts/refresh-dashboards.ts")}`;
	}
	const bash = `bash ${join(ctx.repo, "install.sh")}`;
	switch (step.name) {
		case "refreshSupervisor":
			return `${bash} --refresh-supervisor`;
		case "wireSettings":
			return `${bash} --wire`;
		case "registerLaunchd":
			return `${bash} --with-launchd`;
		default:
			return bash;
	}
}

function pauseFor(
	step: ContractStep,
	ctx: StepContext,
	reason: string,
): { row: StepOutcomeRow; pause: PauseRow } {
	const resume = resumeCommand(step, ctx);
	return {
		row: { name: step.name, status: "need_user_action", note: reason },
		pause: { step: step.name, reason, resume_command: resume },
	};
}

/** Only "real" v1 steps have implementations; the runner guards the rest. */
const impls: Partial<Record<StepName, StepImpl>> = {
	probeEnvironment,
	refreshDashboards,
};

// ─── plan runner ───

export async function executePlan(
	mode: "plan" | "step",
	stepName: string | null,
	ctx: StepContext,
	onRow: RowSink,
): Promise<Executed> {
	const rows: StepOutcomeRow[] = [];
	const pauses: PauseRow[] = [];
	const emit = (row: StepOutcomeRow): void => {
		rows.push(ctx.verbose ? row : { ...row, detail: undefined });
		onRow(row);
	};
	let outcome: OutcomeStatus = "ok";
	let delegated: { ok: boolean; note: string; detail: string } | undefined;
	let delegationFailed = false;
	const selected: ReadonlySet<StepName> = new Set<StepName>(
		mode === "step" && stepName !== null
			? INSTALL_CONTRACT.steps
					.filter((s) => s.name === stepName)
					.map((s) => s.name)
			: INSTALL_CONTRACT.steps.filter((s) => !s.optIn).map((s) => s.name),
	);
	for (const step of INSTALL_CONTRACT.steps) {
		if (!selected.has(step.name)) {
			if (mode === "plan") {
				emit({
					name: step.name,
					status: "skipped",
					note: "opt-in step — reachable via --step",
				});
			}
			continue;
		}
		// dry-run: mutating steps project, read-only steps observe for real
		if (ctx.dryRun && step.mutates) {
			emit({
				name: step.name,
				status: "planned",
				note: "planned (dry-run — zero side effects)",
			});
			continue;
		}
		// unconsented mutating step: pause, never block
		if (!ctx.yes && step.mutates) {
			const p = pauseFor(
				step,
				ctx,
				"mutating step without --yes — run the resume command to perform it, or add --yes",
			);
			emit(p.row);
			pauses.push(p.pause);
			continue;
		}
		// consented non-real step in --step mode: the bash flow is not
		// individually addressable — pause with the closest resume command
		if (step.v1 !== "real" && mode === "step") {
			const p = pauseFor(
				step,
				ctx,
				"the bash installer has no per-step entry point — the resume command runs the full bash flow for this concern",
			);
			emit(p.row);
			pauses.push(p.pause);
			continue;
		}
		// consented full run: one bash delegation covers the delegated steps
		if (step.v1 === "delegated" && mode === "plan") {
			if (delegationFailed) {
				emit({
					name: step.name,
					status: "failed",
					note: "bash delegation failed — see the failing step above",
				});
				continue;
			}
			if (delegated === undefined) {
				delegated = await delegateBash(ctx);
				delegationFailed = !delegated.ok;
			}
			emit({
				name: step.name,
				status: delegated.ok ? "delegated" : "failed",
				note: delegated.note,
				detail: ctx.verbose ? delegated.detail : undefined,
			});
			if (!delegated.ok) outcome = "failed";
			continue;
		}
		// real implementation
		const impl = impls[step.name];
		if (impl === undefined) {
			emit({
				name: step.name,
				status: "failed",
				note: `internal: step ${step.name} is executable but has no v1 implementation`,
			});
			outcome = "failed";
			continue;
		}
		try {
			const r = await impl(ctx);
			emit({ ...r, name: step.name });
			if (r.status === "failed") outcome = "failed";
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emit({ name: step.name, status: "failed", note: msg });
			outcome = "failed";
		}
	}
	// pauses are a first-class outcome, never a failure
	if (pauses.length > 0 && outcome === "ok") outcome = "need_user_action";
	return { rows, pauses, outcome };
}
