// W772.2: CI evidence runner for the npx skills distribution contract
// (vercel-labs/skills, agentskills.io spec) — discovery (--list) + install
// of the first-party fleet skill, identical steps on ubuntu/macos/windows
// runners via `bun x` (the portable bunx). All legs spawn with CWD pinned
// to a disposable scratch dir, so every project-scope write the CLI makes
// (skills-lock.json, agent skill dirs) lands in scratch, never in the
// checkout; the install leg is global (-g) into a scratch CLAUDE_CONFIG_DIR
// — a real add path with a disposable target. The CLI's own --dry-run is
// NOT used: v1.7.2 honors it nowhere on the project install path (it
// installs anyway — observed 2026-10-15), so a no-write plan cannot be
// asserted. Assertions are exit-code + filesystem based, never
// output-shape based.
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// First-party source that exists on every checkout (the fleet pulse skill).
export const FLEET_SKILL_SOURCE = "packages/suspenders/skills/fleet";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

// One argv builder for both legs. The agent value comes LAST: the CLI
// consumes every following non-dash arg as the agent list.
export function buildAddArgs(
	source: string,
	leg: "list" | "install",
): string[] {
	const src = resolve(REPO_ROOT, source);
	return [
		"x",
		"skills",
		"add",
		src,
		...(leg === "list"
			? ["--list"]
			: ["--copy", "-g", "-y", "-a", "claude-code"]),
	];
}

export interface LegResult {
	ok: boolean;
	output: string;
}

// Every leg spawns with cwd = the scratch dir: project-scope writes (the
// skills-lock.json rewrite, project agent dirs) land in scratch. The
// checkout stays byte-identical — asserted after the legs run.
export async function runLeg(
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<LegResult> {
	// spawnSync does not PATH-resolve: pin the absolute bun (setup-bun puts
	// it on PATH in CI; missing bun = loud failure, which is correct there).
	const bunPath = Bun.which("bun") ?? process.execPath;
	if (!existsSync(bunPath)) throw new Error("bun not found");
	const bun = realpathSync(bunPath);
	const proc = Bun.spawnSync([bun, ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 180_000,
	});
	const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
	return { ok: proc.exitCode === 0, output };
}

// The global install contract: CLAUDE_CONFIG_DIR was pinned to
// <scratch>/claude, so the add must materialize
// <scratch>/claude/skills/fleet/SKILL.md — the full real install path,
// disposable target.
export function assertInstalled(scratch: string): void {
	const skillMd = join(scratch, "claude", "skills", "fleet", "SKILL.md");
	if (!existsSync(skillMd))
		throw new Error(`global install did not land: missing ${skillMd}`);
}

// The checkout must stay byte-identical: no project-scope leak into the
// repo (.claude/.agents agent dirs, skills-lock.json rewrite).
export function assertCheckoutClean(): void {
	for (const leak of [".claude/skills", ".agents/skills"]) {
		if (existsSync(join(REPO_ROOT, leak)))
			throw new Error(`project-scope leak: ${leak} exists in the checkout`);
	}
}

export async function skillsCi(): Promise<string[]> {
	const scratch = mkdtempSync(join(tmpdir(), "skills-ci-"));
	const claudeHome = join(scratch, "claude");
	const env = { CLAUDE_CONFIG_DIR: claudeHome };
	const problems: string[] = [];

	const discovery = await runLeg(buildAddArgs(FLEET_SKILL_SOURCE, "list"), scratch, env);
	console.log(`[discovery] exit=${discovery.ok ? 0 : 1}\n${discovery.output.trimEnd()}`);
	if (!discovery.ok) problems.push("discovery leg exited non-zero");
	else if (!discovery.output.includes("fleet"))
		problems.push("discovery output does not mention the fleet skill");

	const install = await runLeg(buildAddArgs(FLEET_SKILL_SOURCE, "install"), scratch, env);
	console.log(`[install] exit=${install.ok ? 0 : 1}\n${install.output.trimEnd()}`);
	if (!install.ok) problems.push("install leg exited non-zero");

	try {
		assertInstalled(scratch);
		assertCheckoutClean();
	} catch (error) {
		problems.push(String(error));
	}

	// Self-arming: once a root skills/ catalog lands (W772.1), discovery of
	// the repo root — the path real users ride — asserts automatically.
	if (existsSync(join(REPO_ROOT, "skills"))) {
		const catalog = await runLeg(buildAddArgs(REPO_ROOT, "list"), scratch, env);
		console.log(`[root-catalog] exit=${catalog.ok ? 0 : 1}\n${catalog.output.trimEnd()}`);
		if (!catalog.ok || !catalog.output.includes("fleet"))
			problems.push("root skills/ catalog exists but discovery did not surface fleet");
	}

	return problems;
}

if (import.meta.main) {
	const problems = await skillsCi();
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL: ${problem}`);
		process.exit(1);
	}
	console.log("skills-ci: discovery + install ok, checkout clean");
}
