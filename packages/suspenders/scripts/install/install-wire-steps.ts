// scripts/install/install-wire-steps.ts — W771.3: native TS ports of the install.sh
// wire-surface blocks (registerCaddy, registerSkills, releaseNotify). The
// user-level wireSettings port lives in install-run.ts where the repo-scoped
// impl already sat. Each function mirrors the retired bash block: non-fatal
// steps keep running the plan, and degraded outcomes surface truthfully
// (W549) instead of being swallowed.
import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { redactSecrets } from "../../hooks/lib/knowledge/knowledge.ts";
import type { StepContext, StepResult } from "./install-run.ts";
import { fleetSkillNames, readSkillLock } from "../install-skill-prune.ts";

const CADDY_LABEL = "com.klh-local.caddy";

/** Bootstrap a LaunchAgent whose plist exists but launchd does not hold;
 *  true only when it was idle and is now loaded. A live job is never
 *  touched — replacing it stays the owning installer's job. */
async function loadIdleUnit(home: string, label: string): Promise<boolean> {
	if (process.platform !== "darwin" || process.getuid === undefined)
		return false;
	const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
	if (!existsSync(plist)) return false;
	const job = `gui/${process.getuid()}/${label}`;
	const held = await execa("/bin/launchctl", ["print", job], { reject: false });
	if (held.exitCode === 0) return false;
	const boot = await execa(
		"/bin/launchctl",
		["bootstrap", `gui/${process.getuid()}`, plist],
		{ reject: false },
	);
	if (boot.exitCode !== 0) return false;
	await Bun.sleep(1000);
	return true;
}

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
	const register = () =>
		execa(
			klhLocal,
			["register", "suspenders", "--port", "7799", "--health", "/"],
			{ reject: false },
		);
	let res = await register();
	// W2177: an installed-but-unloaded Caddy unit (plist on disk, job gone
	// from launchd) loads once and the registration retries
	if (res.exitCode !== 0 && (await loadIdleUnit(ctx.home, CADDY_LABEL)))
		res = await register();
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
	const skillNames = readdirSync(skillsDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(skillsDir, entry.name, "SKILL.md")),
		)
		.map((entry) => entry.name);
	if (skillNames.length === 0) {
		return {
			status: "failed",
			note: `no SKILL.md packages found under ${skillsDir}`,
		};
	}
	// W2177: clean slate — drop every fleet-catalog skill (live names and
	// retired hangers) from all agents before the re-add; other sources stay
	const pruned = fleetSkillNames(readSkillLock(ctx.home), skillsDir);
	if (pruned.length > 0) {
		const removed = await execa(
			"npx",
			["skills", "remove", ...pruned, "-g", "-y"],
			{ stdin: "ignore", reject: false, env: { HOME: ctx.home } },
		);
		if (removed.exitCode !== 0) {
			return {
				status: "failed",
				note: `skills prune failed (${pruned.length} fleet skills) — run manually: npx skills remove ${pruned.join(" ")} -g -y`,
			};
		}
	}
	const res = await execa(
		"npx",
		["skills", "add", skillsDir, "-g", "-y", "-a", "claude-code"],
		{ stdin: "ignore", reject: false, env: { HOME: ctx.home } },
	);
	if (res.exitCode !== 0) {
		const stderr = redactSecrets(res.stderr)
			.text.replace(/\s+/g, " ")
			.trim()
			.slice(-240);
		return {
			status: "failed",
			note: `skills registration failed${stderr ? `: ${stderr}` : ""} — run manually: npx skills add ${skillsDir} -g -y -a claude-code`,
		};
	}
	const installed = join(ctx.home, ".claude", "skills");
	const missing = skillNames.filter(
		(name) => !existsSync(join(installed, name, "SKILL.md")),
	);
	if (missing.length > 0) {
		return {
			status: "failed",
			note: `skills CLI exited successfully but ${missing.length}/${skillNames.length} Claude skills are missing under ${installed}: ${missing.slice(0, 3).join(", ")}`,
		};
	}
	const retired = retireLegacyEcosystemSkill(ctx.home, skillNames);
	return {
		status: "ok",
		note: `registered and verified ${skillNames.length} Claude skills from ${skillsDir}${pruned.length > 0 ? ` after pruning ${pruned.length} prior fleet installs` : ""}${retired > 0 ? `; retired ${retired} obsolete ecosystem-map copies` : ""}`,
	};
}

/** Remove only the pre-monorepo skill installed by the retired speedy installer. */
function retireLegacyEcosystemSkill(
	home: string,
	skillNames: string[],
): number {
	const name = "klh-ecosystem-map";
	if (skillNames.includes(name)) return 0;
	let removed = 0;
	for (const agent of [".claude", ".agents"]) {
		const dir = join(home, agent, "skills", name);
		if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
		const entries = readdirSync(dir);
		if (entries.length !== 1 || entries[0] !== "SKILL.md") continue;
		const skillFile = join(dir, "SKILL.md");
		if (!lstatSync(skillFile).isFile()) continue;
		const contents = readFileSync(skillFile, "utf8");
		if (
			!contents.includes("name: klh-ecosystem-map\n") ||
			!contents.includes("## The five repos") ||
			!contents.includes(
				"Call chain for an LLM request: **surface (Claude/Copilot/VS Code) → belt",
			) ||
			!contents.includes("Poll your inbox at session start")
		)
			continue;
		rmSync(dir, { recursive: true });
		removed++;
	}
	return removed;
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
