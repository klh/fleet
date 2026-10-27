// scripts/install-preflight.ts — W1195.1: the installer's mutation preflight.
// The 2026-10-23 incident ran install --with-launchd from an unreviewed item
// worktree: syncHarness replaced the live harness prefix, and only THEN did
// registerLaunchd's stable-worktree authority guard refuse — persistent
// mutation first, detection last. This module evaluates the refusal
// conditions of steps that run LATER in the same run BEFORE the plan's first
// mutating step (syncHarness publishes the harness). It reuses the steps' own
// guards — no new approval path, no skipped health/auth check: the steps
// still re-run every guard before their own mutations.
import { join } from "node:path";
import type { StepName } from "./install-contract.ts";
import { resolveStableRepo } from "./install-launchd.ts";
import type { StepContext } from "./install-run.ts";
import { validateBeltWiredGuard } from "./lib/belt-wired-guard.ts";

export interface PreflightFinding {
	/** the step whose refusal was predicted */
	step: StepName;
	/** the step's own guard refusal text, verbatim */
	refusal: string;
}

/**
 * registerLaunchdPreflight — the launchd step's cross-step refusal
 * conditions, evaluated with the SAME guards the step itself applies
 * (resolveStableRepo, validateBeltWiredGuard). Non-darwin: the step skips
 * (never refuses), so the preflight stays silent. An empty result means the
 * step will not refuse on these authority guards — it still re-checks them
 * (plus the route preflight) before rendering or loading anything.
 */
export function registerLaunchdPreflight(ctx: StepContext): PreflightFinding[] {
	if (process.platform !== "darwin") return [];
	const findings: PreflightFinding[] = [];
	const stable = resolveStableRepo(ctx.repo, ctx.prefix);
	if (!stable.ok)
		findings.push({ step: "registerLaunchd", refusal: stable.refusal });
	const home = ctx.home || process.env.HOME || "";
	const guard = validateBeltWiredGuard(
		join(home, ".claude", "local-llm", "belt.env"),
	);
	if (!guard.ok)
		findings.push({
			step: "registerLaunchd",
			refusal: `${guard.reason}; Belt and dispatch require the same machine value before activation`,
		});
	return findings;
}
