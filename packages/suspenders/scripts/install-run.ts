// scripts/install-run.ts — the W490.1 install plan runner: v1 step
// implementations (only "real" steps live here), the bash delegation, the
// pause builder, and executePlan. Pure logic — no CLI parsing, no printing.
// The contract (scripts/install-contract.ts) is the frozen surface.
import { join } from "node:path";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { upgradeGateway } from "./upgrade-gateway.ts";
import { registerLaunchd } from "./install-launchd.ts";
import { syncHarness } from "./sync-harness.ts";

export interface StepContext {
	dryRun: boolean;
	yes: boolean;
	json: boolean;
	verbose: boolean;
	gatewayReview?: string;
	repo: string;
	prefix: string;
	shimBin: string;
	llmHome: string;
	/** W637: with --step wireSettings — the repo whose project settings get wired */
	wireRepo: string | null;
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

interface DelegatedResult {
	ok: boolean;
	note: string;
	detail: string;
	steps: Partial<Record<StepName, StepResult>>;
}

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

// W637: real wireSettings — merges the settings.example.json hooks block into
// <wireRepo>/.claude/settings.json: per-event array concat, dedupe on JSON
// form, $HOME placeholder rewritten to the real prefix. No --wire-repo: the
// user-level wire stays bash-owned (the step pauses with the bash resume).
export async function wireSettings(ctx: StepContext): Promise<StepResult> {
	if (ctx.wireRepo === null) {
		return {
			status: "need_user_action",
			note: "user-level wire is under install.sh --wire — pass --wire-repo <path> to wire a repo's project settings",
		};
	}
	const repo = realpathSync(ctx.wireRepo);
	const settingsPath = join(repo, ".claude", "settings.json");
	let ex: { hooks: Record<string, unknown> };
	try {
		ex = JSON.parse(
			readFileSync(join(ctx.repo, "settings.example.json"), "utf8"),
		);
	} catch {
		return {
			status: "failed",
			note: `settings.example.json unreadable at ${ctx.repo} — the wire step runs from a fleet checkout`,
		};
	}
	const doc = (() => {
		try {
			return JSON.parse(readFileSync(settingsPath, "utf8")) as {
				hooks?: Record<string, unknown>;
			};
		} catch {
			return {} as { hooks?: Record<string, unknown> };
		}
	})();
	doc.hooks ??= {};
	let added = 0;
	for (const [event, entries] of Object.entries(ex.hooks)) {
		const rewritten = JSON.parse(
			JSON.stringify(entries).replaceAll(
				"$HOME/.claude/hooks/suspenders",
				ctx.prefix,
			),
		) as unknown[];
		const cur = (
			Array.isArray(doc.hooks[event]) ? doc.hooks[event] : []
		) as unknown[];
		doc.hooks[event] = cur;
		const seen = new Set(cur.map((m) => JSON.stringify(m)));
		for (const e of rewritten) {
			if (!seen.has(JSON.stringify(e))) {
				cur.push(e);
				added++;
			}
		}
	}
	mkdirSync(join(repo, ".claude"), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
	return {
		status: "ok",
		note: `wired ${settingsPath} (per-event merge, ${added} new hook entries)`,
	};
}

// W650: repo-level scrub-gate enforcement — committed .githooks stubs (W236)
// exec hooks/bin/scrub-gate.ts from the installed prefix (fallback:
// repo-local packages/suspenders), fail inert without the stack.
export async function registerGitHooks(ctx: StepContext): Promise<StepResult> {
	const top = await execa(
		"git",
		["-C", ctx.repo, "rev-parse", "--show-toplevel"],
		{ reject: false },
	);
	if (top.failed || top.exitCode !== 0) {
		return {
			status: "skipped",
			note: `${ctx.repo} is not a git checkout — nothing to register`,
		};
	}
	const root = top.stdout.trim();
	for (const stub of [".githooks/pre-commit", ".githooks/pre-push"]) {
		if (!existsSync(join(root, stub))) {
			return {
				status: "failed",
				note: `committed ${stub} missing at ${root}`,
			};
		}
	}
	const set = await execa(
		"git",
		["-C", root, "config", "core.hooksPath", ".githooks"],
		{ reject: false },
	);
	if (set.failed || set.exitCode !== 0) {
		return {
			status: "failed",
			note: `git config core.hooksPath failed — ${set.stderr.trim()}`,
		};
	}
	const verify = await execa("git", ["-C", root, "config", "core.hooksPath"], {
		reject: false,
	});
	const wired = verify.stdout?.trim() === ".githooks";
	return {
		status: wired ? "ok" : "failed",
		note: wired
			? `core.hooksPath=.githooks on ${root} — bare-git commits run the scrub gate (fail-inert without the stack)`
			: `core.hooksPath did not read back as .githooks (got: ${verify.stdout?.trim() ?? ""})`,
	};
}

/**
 * The v1 delegation: one bash install.sh invocation covers every mutating
 * "delegated" step on a consented full run. W490.2: install.sh's public face
 * is the TS installer wrapper, so the delegation targets the wrapper's
 * __legacy full entrypoint (the legacy body blocks install.ts has no step
 * for yet) — never the wrapper front, which would recurse.
 */
async function delegateBash(ctx: StepContext): Promise<DelegatedResult> {
	const script = join(ctx.repo, "install.sh");
	const reportDir = mkdtempSync(join(tmpdir(), "fleet-install-report-"));
	const report = join(reportDir, "steps.ndjson");
	try {
		const res = await execa("bash", [script, "__legacy", "full"], {
			cwd: ctx.repo,
			stdout: ctx.json ? "pipe" : "inherit",
			stderr: "inherit",
			env: { SUSPENDERS_LEGACY_REPORT: report },
			reject: false,
		});
		if (res.exitCode !== 0) {
			return {
				ok: false,
				note: `bash delegation failed (exit ${res.exitCode ?? "signal"})`,
				detail: "",
				steps: {},
			};
		}
		const text = typeof res.stdout === "string" ? res.stdout : "";
		const tail = text.trim().split("\n").at(-1) ?? "";
		const steps: DelegatedResult["steps"] = {
			registerCaddy: {
				status: "failed",
				note: "Caddy registration outcome was not reported; installation cannot be verified",
			},
		};
		try {
			for (const line of readFileSync(report, "utf8")
				.split("\n")
				.filter(Boolean)) {
				const row = JSON.parse(line) as {
					name: unknown;
					status: unknown;
					note: unknown;
				};
				if (
					typeof row.name !== "string" ||
					!["registerCaddy", "registerGitHooks"].includes(row.name) ||
					typeof row.status !== "string" ||
					!["ok", "failed", "skipped"].includes(row.status) ||
					typeof row.note !== "string"
				)
					throw new Error("invalid legacy step report");
				// registerGitHooks is native ("real") — a legacy-body row for it is
				// tolerated here, never consumed: the plan's own run reported it.
				if (row.name === "registerGitHooks") continue;
				steps.registerCaddy = {
					status: row.status as StepStatus,
					note: row.note,
				};
			}
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "ENOENT"))
				throw new Error("invalid legacy step report");
		}
		return {
			ok: true,
			note: "executed via the v1 bash delegation (install.sh __legacy full)",
			detail: tail,
			steps,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			note: `bash delegation failed — ${msg}`,
			detail: "",
			steps: {},
		};
	} finally {
		rmSync(reportDir, { recursive: true, force: true });
	}
}

// ─── pause states (first-class: resume_command, never a blocking prompt) ───

function resumeCommand(step: ContractStep, ctx: StepContext): string {
	if (step.name === "refreshDashboards") {
		return `bun ${join(ctx.repo, "scripts/refresh-dashboards.ts")}`;
	}
	if (step.name === "registerLaunchd") {
		// native since W490.2 — renders deploy/services.yaml via install-services.ts
		return `bun ${join(ctx.repo, "scripts/install.ts")} --step registerLaunchd --yes`;
	}
	if (step.name === "deployHub") {
		// v1 stub: hub deploys ride the bash flag (deploy/hubctl.ts); the hub
		// name is operator data from stack.yaml, filled in before running
		return `bash ${join(ctx.repo, "install.sh")} --hub <hub>`;
	}
	// the wrapper front is consented-by-design (bash surface semantics), and
	// --yes makes the resume self-sufficient through the TS plan runner
	const bash = `bash ${join(ctx.repo, "install.sh")} --yes`;
	switch (step.name) {
		case "syncHarness":
			return `${bash} --step syncHarness`;
		case "refreshSupervisor":
			return `${bash} --refresh-supervisor`;
		case "wireSettings":
			return `${bash} --wire`;
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
	registerGitHooks,
	registerLaunchd,
	upgradeGateway,
	syncHarness,
	wireSettings,
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
	let delegated: DelegatedResult | undefined;
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
		if (
			(step.v1 === "delegated" || step.name === "syncHarness") &&
			mode === "plan"
		) {
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
			const row: StepOutcomeRow = {
				name: step.name,
				status: delegated.ok ? "delegated" : "failed",
				note: delegated.note,
				detail: ctx.verbose ? delegated.detail : undefined,
				...(delegated.ok ? delegated.steps[step.name] : undefined),
			};
			emit(row);
			if (row.status === "failed") outcome = "failed";
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
			// W637: an impl can fold to a pause (wireSettings without
			// --wire-repo — the user-level wire stays bash-owned)
			if (r.status === "need_user_action") {
				const p = pauseFor(step, ctx, r.note);
				pauses.push(p.pause);
				continue;
			}
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
