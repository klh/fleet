// scripts/install-wire-steps.ts — W771.3: native TS ports of the install.sh
// wire-surface blocks (registerCaddy, registerSkills, releaseNotify). The
// user-level wireSettings port lives in install-run.ts where the repo-scoped
// impl already sat. Each function mirrors the retired bash block: non-fatal
// steps keep running the plan, and degraded outcomes surface truthfully
// (W549) instead of being swallowed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { StepContext, StepResult } from "./install-run.ts";

/**
 * registerCaddy — optional board registration with klh-local/Caddy so the LAN
 * gets http://suspenders.local:7799. Idempotent; optional tool absence is a
 * skip; a stale klh-local (predates W602, unloadable loopback `bind`
 * posture) degrades with the remediation instead of attempting a reload that
 * cannot load (W631); a failed registration is a truthful failed row (W549).
 */
export async function registerCaddy(ctx: StepContext): Promise<StepResult> {
	const klhLocal = join(ctx.home, ".local", "bin", "klh-local");
	const caddy = Bun.which("caddy");
	if (caddy === null || !existsSync(klhLocal)) {
		return {
			status: "skipped",
			note: "optional klh-local/Caddy tools unavailable; registration was not attempted",
		};
	}
	const posture = readFileSync(klhLocal, "utf8");
	if (!posture.includes("abort @external")) {
		return {
			status: "failed",
			note: "installed klh-local predates W602 (unloadable loopback bind posture) — refresh via packages/local/install.sh before registering",
		};
	}
	const res = await execa(
		klhLocal,
		["register", "suspenders", "--port", "7799", "--health", "/"],
		{
			reject: false,
		},
	);
	if (res.exitCode !== 0) {
		return {
			status: "failed",
			note: "optional Caddy registration failed; harness installed, use the loopback board URL http://127.0.0.1:7799 and inspect Caddy reload/rollback",
		};
	}
	return {
		status: "ok",
		note: "board registered with klh-local/Caddy (suspenders.local → 127.0.0.1:7799)",
	};
}

/**
 * registerSkills — register every skill package under skills/ with the skills
 * CLI (owner hard rule 2026-10-07: agent surfaces distribute as SKILL.md
 * packages, never cp'd into one CLI's dir). Flags are load-bearing: -g global,
 * -y unattended, -a explicit agent — a bare add hits the interactive
 * agent-picker and exits 1 in a non-TTY. Best-effort: failure names the
 * manual command instead of aborting the install.
 *
 * W903: the catalog lives at the git repo root, not under packages/suspenders
 * (what ctx.repo is) — resolve the toplevel like registerGitHooks does;
 * non-git trees fall back to ctx.repo.
 */
export async function registerSkills(ctx: StepContext): Promise<StepResult> {
	const top = await execa(
		"git",
		["-C", ctx.repo, "rev-parse", "--show-toplevel"],
		{ reject: false },
	);
	const repoRoot =
		top.failed || top.exitCode !== 0 || top.stdout.trim() === ""
			? ctx.repo
			: top.stdout.trim();
	const skillsDir = join(repoRoot, "skills");
	if (!existsSync(skillsDir)) {
		return {
			status: "skipped",
			note: `no skills/ directory at ${repoRoot} — nothing to register`,
		};
	}
	const res = await execa(
		"bunx",
		["skills", "add", skillsDir, "-g", "-y", "-a", "claude-code"],
		{ stdin: "ignore", reject: false },
	);
	if (res.exitCode !== 0) {
		return {
			status: "failed",
			note: `skills registration failed — run manually: bunx skills add ${skillsDir} -g -y -a claude-code`,
		};
	}
	return {
		status: "ok",
		note: `registered all packages under ${skillsDir}`,
	};
}

/**
 * releaseNotify — the distributed changelog: every deploy announces the live
 * version on the coord bus; every session sees it at next poll or
 * SessionStart. Fresh machines (no coord at the prefix) skip. The emit is
 * best-effort — a failure is a truthful failed row, never an install abort.
 */
export async function releaseNotify(ctx: StepContext): Promise<StepResult> {
	const coord = join(ctx.prefix, "bin", "coord.ts");
	if (!existsSync(coord)) {
		return {
			status: "skipped",
			note: "coord not installed at the prefix — fresh machine, no release announcement",
		};
	}
	const ver = await execa(
		"git",
		["-C", ctx.repo, "describe", "--tags", "--abbrev=0"],
		{ reject: false },
	);
	const version =
		ver.exitCode === 0 && ver.stdout.trim() !== ""
			? ver.stdout.trim()
			: "unknown";
	let note = "deployed";
	if (version !== "unknown") {
		const subject = await execa(
			"git",
			["-C", ctx.repo, "tag", "-l", "--format=%(contents:subject)", version],
			{ reject: false },
		);
		const first = subject.stdout.trim().split("\n")[0] ?? "";
		if (first !== "") note = first;
	}
	const emit = await execa(
		process.execPath,
		[
			coord,
			"emit",
			"RELEASE",
			"--scope",
			"suspenders",
			"--version",
			version,
			"--note",
			note,
			"--as",
			"installer",
		],
		{ reject: false },
	);
	if (emit.exitCode !== 0) {
		return {
			status: "failed",
			note: "release emit failed (non-fatal) — the announcement rides the next successful install",
		};
	}
	return {
		status: "ok",
		note: `RELEASE ${version} announced on the coord bus`,
	};
}
