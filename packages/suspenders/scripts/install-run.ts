// scripts/install-run.ts — the W490.1 install plan runner: v1 step
// implementations (only "real" steps live here), the bash delegation, the
// pause builder, and executePlan. Pure logic — no CLI parsing, no printing.
// The contract (scripts/install-contract.ts) is the frozen surface.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { ensureShims } from "./ensure-shims.ts";
import { migrateConf } from "./install-conf-migrate.ts";
import { wireConnections } from "./install-connections.ts";
import {
	type ContractStep,
	INSTALL_CONTRACT,
	type OutcomeStatus,
	type PauseRow,
	type StepName,
	type StepOutcomeRow,
	type StepStatus,
} from "./install-contract.ts";
import { registerLaunchd } from "./install-launchd.ts";
import {
	downloadModels,
	refreshSupervisor,
	seedLocalLlm,
} from "./install-llm-steps.ts";
import {
	registerCaddy,
	registerSkills,
	releaseNotify,
} from "./install-wire-steps.ts";
import { sourcePaths, syncHarness } from "./sync-harness.ts";
import { upgradeGateway } from "./upgrade-gateway.ts";

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
	/** W771.3: the user home — the user-level wireSettings target root */
	home: string;
	/** W637: with --step wireSettings — the repo whose project settings get wired */
	wireRepo: string | null;
	/** W165: with --step syncHarness — spoke excludes hub-only modules from the
	 *  payload and capabilities.json records the variant (absent = hub). */
	profile?: "hub" | "spoke";
	/** W420 mirror mode — drops unmanaged prefix entries outside the allowlist. */
	prune?: boolean;
	/** --skip-models: downloadModels skips (offline installs) */
	skipModels?: boolean;
	/** --no-llm: the local-llm baseline skips entirely (CI/containers) */
	noLlm?: boolean;
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

// loadSettingsDoc — read a settings.json doc; missing/corrupt starts from {}.
function loadSettingsDoc(settingsPath: string): {
	hooks?: Record<string, unknown>;
} {
	try {
		return JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
	} catch {
		return {};
	}
}

// groupSignature — canonical compare form for a hook group: matcher plus the
// sorted type+command set with $HOME expanded to the real home first, then
// the prefix folded to "@". Expansion MUST precede the fold (W904): folding
// prefix→"@" before expanding $HOME left the placeholder form collapsing to
// `@/.claude/hooks/suspenders/…` while the absolute form collapsed to
// `@/…` — divergent signatures, re-wires appended both forms. Groups that
// differ only in key order, timeout or placeholder-vs-real-path converge
// instead of duplicating on re-run (W860 ask-gate follow-up).
function groupSignature(group: unknown, prefix: string, home: string): string {
	if (typeof group !== "object" || group === null) return JSON.stringify(group);
	const g = group as { matcher?: unknown; hooks?: unknown };
	const hooks = Array.isArray(g.hooks) ? g.hooks : [];
	const cmds = hooks
		.map((h) => {
			if (typeof h !== "object" || h === null) return JSON.stringify(h);
			const hook = h as { type?: unknown; command?: unknown };
			const command = String(hook.command ?? "")
				.replaceAll("$HOME", home)
				.replaceAll(prefix, "@");
			return `${String(hook.type ?? "")}\u0000${command}`;
		})
		.sort();
	return JSON.stringify([g.matcher ?? null, cmds]);
}

// mergeHooksInto — per-event hooks merge: array concat, dedupe on JSON form,
// then on groupSignature (same commands under the same matcher = already
// wired), $HOME placeholder → real prefix. W904: entries ALREADY in the
// settings are signature-collapsed keep-first first (a settings carrying the
// $HOME-form and absolute-form of the same gate command heals to one entry
// on the next wire run), then the example set merges against the deduped
// list. Returns the added/removed counts.
function mergeHooksInto(
	settingsPath: string,
	ex: { hooks: Record<string, unknown> },
	prefix: string,
	home: string,
): { added: number; removed: number } {
	const doc = loadSettingsDoc(settingsPath);
	doc.hooks ??= {};
	let added = 0;
	let removed = 0;
	for (const [event, entries] of Object.entries(ex.hooks)) {
		const rewritten = JSON.parse(
			JSON.stringify(entries).replaceAll(
				"$HOME/.claude/hooks/suspenders",
				prefix,
			),
		) as unknown[];
		const cur = (
			Array.isArray(doc.hooks[event]) ? doc.hooks[event] : []
		) as unknown[];
		// W904: collapse keep-first on the canonical signature — a settings
		// carrying the $HOME-form AND the absolute-form of the same gate
		// command (the W893 finding) heals to one entry on the next wire run.
		const sigs = new Set<string>();
		const kept: unknown[] = [];
		for (const m of cur) {
			const sig = groupSignature(m, prefix, home);
			if (sigs.has(sig)) {
				removed++;
				continue;
			}
			sigs.add(sig);
			kept.push(m);
		}
		doc.hooks[event] = kept;
		const seen = new Set(kept.map((m) => JSON.stringify(m)));
		for (const e of rewritten) {
			if (seen.has(JSON.stringify(e))) continue;
			const sig = groupSignature(e, prefix, home);
			if (sigs.has(sig)) continue;
			kept.push(e);
			sigs.add(sig);
			seen.add(JSON.stringify(e));
			added++;
		}
	}
	writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
	return { added, removed };
}

// wireNote — the wireSettings success note; the collapsed count only shows
// when the merge healed existing duplicates (W904).
function wireNote(
	settingsPath: string,
	added: number,
	removed: number,
	extras = "",
): string {
	return `wired ${settingsPath} (per-event merge, ${added} new hook entries)${removed > 0 ? `, collapsed ${removed} duplicate group(s)` : ""}${extras}`;
}

export async function wireSettings(ctx: StepContext): Promise<StepResult> {
	if (ctx.wireRepo === null) {
		return userLevelWire(ctx);
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
	mkdirSync(join(repo, ".claude"), { recursive: true });
	const { added, removed } = mergeHooksInto(
		settingsPath,
		ex,
		ctx.prefix,
		ctx.home,
	);
	return { status: "ok", note: wireNote(settingsPath, added, removed) };
}

// runWireExtras — the user-level wire's companions: policy adapters (fatal on
// failure) and the W294 gate wires (merge-not-clobber, non-fatal). Returns a
// note suffix describing degraded surfaces; "" when everything ran clean.
// Exported for install-wire-extras.test.ts (W918.5 prefix-face preference).
// reason: W918.5 — export runWireExtras so the prefix-face wire preference is unit-testable.
export async function runWireExtras(ctx: StepContext): Promise<string> {
	const adapters = await execa(
		process.execPath,
		[join(ctx.repo, "scripts/install-policy-adapters.ts")],
		{
			cwd: ctx.repo,
			// env replaces, never merges — keep the operator environment so the
			// adapter resolves HOME/CODEX_HOME/etc. instead of repo-relative paths
			env: { ...process.env, SUSPENDERS_PREFIX: ctx.prefix },
			reject: false,
		},
	);
	if (adapters.exitCode !== 0) {
		return " — policy adapters failed (non-fatal)";
	}
	let extras = "";
	// W778: the W73 gate wires live at hooks/dialects/<x>/wire.ts (their
	// header even says so) — the W771.3 port pointed at a bin/ path that no
	// publisher ever filled, so the wires silently never ran. The wire step
	// already requires a fleet checkout (settings.example.json), so fall back
	// to ctx.repo when no prefix face carries them.
	// W918.5: PREFER the installed-face copy — the wire bakes `import.meta.dir`
	// -relative gate paths, so a checkout-sourced run strands the wiring when
	// that checkout dies (the deleted W893 worktree broke every copilot hook
	// on this machine). syncHarness runs earlier in the plan, so the prefix
	// copy is fresh at wire time.
	for (const dialect of ["codex", "copilot"]) {
		const prefixScript = join(
			ctx.prefix,
			".harness",
			"packages",
			"suspenders",
			"hooks",
			"dialects",
			dialect,
			"wire.ts",
		);
		const script = existsSync(prefixScript)
			? prefixScript
			: join(ctx.repo, "hooks", "dialects", dialect, "wire.ts");
		if (!existsSync(script)) {
			extras += ` — ${dialect} gate wire missing (skipped)`;
			continue;
		}
		const res = await execa(process.execPath, [script], {
			cwd: ctx.repo,
			reject: false,
		});
		if (res.exitCode !== 0) {
			extras += ` — ${dialect} gate wire merge failed (non-fatal)`;
		}
	}
	return extras;
}

// userLevelWire — the ~/.claude/settings.json wire: merge hooks, then policy
// adapters + gate wires. Missing settings file starts from {}.
async function userLevelWire(ctx: StepContext): Promise<StepResult> {
	const settingsPath = join(ctx.home, ".claude", "settings.json");
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
	mkdirSync(join(ctx.home, ".claude"), { recursive: true });
	if (!existsSync(settingsPath)) writeFileSync(settingsPath, "{}\n");
	const { added, removed } = mergeHooksInto(
		settingsPath,
		ex,
		ctx.prefix,
		ctx.home,
	);
	const extras = await runWireExtras(ctx);
	return { status: "ok", note: wireNote(settingsPath, added, removed, extras) };
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

// ─── pause states (first-class: resume_command, never a blocking prompt) ───

function resumeCommand(step: ContractStep, ctx: StepContext): string {
	if (step.name === "refreshDashboards") {
		return `bun ${join(ctx.repo, "scripts/refresh-dashboards.ts")}`;
	}
	if (step.name === "deployHub") {
		// v1 stub: hub deploys ride the --hub early exit; the hub name is
		// operator data from stack.json, filled in before running
		return `bun ${join(ctx.repo, "scripts/install.ts")} --hub <hub>`;
	}
	// every native step resumes through the TS door (W771.3: wrapper is a pure exec)
	return `bun ${join(ctx.repo, "scripts/install.ts")} --step ${step.name} --yes`;
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
	ensureShims,
	migrateConf,
	wireSettings,
	wireConnections,
	registerCaddy,
	registerSkills,
	releaseNotify,
	seedLocalLlm,
	downloadModels,
	refreshSupervisor,
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
				// W1295: syncHarness names its ship list so a dry-run proves the
				// payload — W1466: the computed closure (read-only: git ls-tree +
				// module reads), the same list a real sync archives.
				note:
					step.name === "syncHarness"
						? `planned (dry-run — zero side effects); payload: ${(await sourcePaths(ctx.repo)).join(", ")}`
						: "planned (dry-run — zero side effects)",
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
				"this stub points at the --hub early exit — the resume command names the door",
			);
			emit(p.row);
			pauses.push(p.pause);
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
			// W637: an impl can fold to a pause (wireSettings without a wire
			// target pauses for the operator to choose user-level vs repo)
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
