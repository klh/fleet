// hooks/lib/executors/codex.ts — the codex CLI adapter (W422 law: one file
// per agent; facts verified W73/W296 + the 0.158 binary probes).
import { existsSync, writeFileSync } from "node:fs";
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";

// codex's seatbelt denies every write into any .git directory (name-based,
// verified empirically 2026-09-28), so the standard worktree layout (admin
// dir + objects under REPO/.git) can never commit. The lane gets a PRIVATE
// git store under a non-.git name inside its workspace, wired with
// GIT_DIR/GIT_WORK_TREE env: main-repo objects are shared read-only via
// alternates; the lane's own objects/refs land in the private store — the
// main object db stays seatbelt-protected. (W422.21: the recipe moved here
// from fleet-loop — agent specifics live in the adapter file.)
export const ensureCodexGitStore = (o: {
	wt: string;
	repo: string;
	main: string;
	item: string;
}): void => {
	const store = `${o.wt}/.gitstore`;
	if (existsSync(`${store}/HEAD`)) {
		// resume: re-point the .git file — the pointer must be exact before
		// anyone spawns (same write the fresh path ends with below).
		writeFileSync(`${o.wt}/.git`, `gitdir: ${store}\n`);
		return;
	}
	Bun.spawnSync(["git", "init", "--quiet", "--bare", store]);
	const g = (args: string[]): void => {
		Bun.spawnSync(["git", "--git-dir", store, ...args], {
			cwd: o.repo,
			stdout: "ignore",
			stderr: "ignore",
		});
	};
	g(["config", "core.bare", "false"]);
	g(["config", "core.worktree", o.wt]);
	writeFileSync(`${store}/objects/info/alternates`, `${o.repo}/.git/objects\n`);
	g([
		"update-ref",
		`refs/heads/suspenders/${o.item}`,
		shGit(["-C", o.repo, "rev-parse", o.main]),
	]);
	g(["symbolic-ref", "HEAD", `refs/heads/suspenders/${o.item}`]);
	g(["reset", "--hard", "--quiet"]);
	g([
		"remote",
		"add",
		"origin",
		shGit(["-C", o.repo, "remote", "get-url", "origin"]),
	]);
	// loud, never silent: verify the store landed on the lane's branch
	// before spawning anyone (unborn main = lane can push origin main)
	const head = Bun.spawnSync(
		["git", "--git-dir", store, "symbolic-ref", "--short", "HEAD"],
		{ stdout: "pipe" },
	)
		.stdout?.toString()
		.trim();
	if (head !== `suspenders/${o.item}`) {
		console.error(
			`codex store init failed: HEAD=${head || "unborn"} — inspect ${store}`,
		);
		throw new Error("direct launch preparation failed");
	}
	writeFileSync(`${o.wt}/.git`, `gitdir: ${store}\n`);
};

// trimmed combined output — same recipe as the dispatch core's `sh` helper
const shGit = (args: string[]): string => {
	const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim();
};

export const codexAdapter: ExecutorAdapter = {
	id: "codex",
	names: ["codex"],
	bin: "codex",
	spawnable: true,
	// No observed codex brief mangling — warn-only (verifyBrief has no codex
	// profile yet; adding one = one brief-verify row, zero core branches).
	briefHarness: "claude",
	briefHardGate: false,
	// The codex spawn grammar: `exec` subcommand with the prompt LAST (W73).
	spawnArgs: () => ["--sandbox", "danger-full-access"],
	promptArgs: (prompt) => ["exec", prompt],
	// `exec resume <id>` chaining verified on the 0.158 binary (W454 probe);
	// wiring waits on the spawn-recipe composition (module header, W454).
	forkArgs: () => null,
	// seatbelt workspaces + AGENTS.md sandbox facts live in the codex dialect
	// (hooks/dialects/codex/); the private-store recipe above is the launch
	// row's payload.
	processNames: ["codex"],
	// W422.21 direct-launch rows: seatbelt plain-dir workspace + private git
	// store; SUSPENDERS_SID is the identity channel (no protocol var, W73).
	wireDialect: "codex",
	workspace: "plain-dir",
	privateGitStore: true,
	identityProtocol: false,
	coordBootstrap: false,
	// full access — owner directive 2026-09-28: codex lanes are EQUIVALENT to
	// claude lanes (same trust class, unsandboxed). The seatbelt structurally
	// denies git writes, which forked the protocol into lane-commits vs
	// coordinator-commits; one approach, two backends. The private git store
	// stays: even unsandboxed, a codex lane's commits never touch the main
	// object db until the coordinator merges.
	launchArgs: ({ prompt }) => ["exec", ...codexAdapter.spawnArgs({}), prompt],
	initWorkspaceGit: ensureCodexGitStore,
};
