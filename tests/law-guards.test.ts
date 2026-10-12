// W715: AGENTS.md laws as CI guards (W694 review L4/L5).
// L4 — the 1500-line hard limit on any .ts. The on-write gate only sees
// Write/Edit payloads; this guard sees every commit. Scans TRACKED files,
// so scratch and .worktrees cannot red it.
// L5 — the shell-script ban: the tracked .sh set is PINNED here by exact
// equality. A new .sh fails the guard until an explicit allowlist entry
// argues why bun won't do; removing a .sh must drop its entry too, so the
// list cannot rot silently.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LINE_LIMIT = 1500;

// The legacy .sh set (W694 L5): installer entrypoints, the launchd loader
// and its test harness, speedy harness hook shims and skill scripts.
const SH_ALLOWLIST = [
	"packages/belt/install.sh",
	"packages/local/install.sh",
	"packages/speedy/hooks/config-guard.sh",
	"packages/speedy/hooks/daily-insights.sh",
	"packages/speedy/hooks/edit-enforce.sh",
	"packages/speedy/hooks/secrets-gate.sh",
	"packages/speedy/hooks/session-start.sh",
	"packages/speedy/hooks/skill-install-gate.sh",
	"packages/speedy/hooks/tool-enforce.sh",
	"packages/speedy/install.sh",
	"packages/speedy/skills-available/idea-refine/scripts/idea-refine.sh",
	"packages/speedy/skills/az/scripts/az-auth-status.sh",
	"packages/speedy/skills/az/scripts/az-context.sh",
	"packages/speedy/skills/az/scripts/az-diagnostics.sh",
	"packages/speedy/skills/az/scripts/az-preflight.sh",
	"packages/speedy/skills/az/scripts/install.sh",
	"packages/speedy/skills/brainstorming/scripts/start-server.sh",
	"packages/speedy/skills/brainstorming/scripts/stop-server.sh",
	"packages/speedy/skills/docker/scripts/install.sh",
	"packages/speedy/skills/quiet-work/scripts/apply.sh",
	"packages/speedy/skills/sqlite/scripts/install.sh",
	"packages/speedy/skills/sqlite/scripts/sqlite_backup.sh",
	"packages/speedy/skills/sqlite/scripts/sqlite_healthcheck.sh",
	"packages/speedy/skills/sqlite/scripts/sqlite_preflight.sh",
	"packages/speedy/skills/sqlite/scripts/sqlite_safe_query.sh",
	"packages/speedy/skills/zsh/scripts/install.sh",
	"packages/suspenders/install.sh",
	"packages/suspenders/scripts/load-launchd.sh",
	"packages/suspenders/test/load-launchd.test.sh",
];

function tracked(pattern: string): string[] {
	const out = Bun.spawnSync(["git", "ls-files", pattern], { cwd: ROOT });
	if (out.exitCode !== 0) {
		throw new Error(`git ls-files ${pattern} failed: ${out.stderr}`);
	}
	return new TextDecoder()
		.decode(out.stdout)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

test("no tracked .ts exceeds the 1500-line law", () => {
	const over = tracked("*.ts")
		.map(
			(f) =>
				[
					f,
					readFileSync(join(ROOT, f), "utf8").split("\n").length,
				] as const,
		)
		.filter(([, n]) => n > LINE_LIMIT);
	expect(
		over.map(([f, n]) => `${f}: ${n} > ${LINE_LIMIT}`),
		"files over the 1500-line law — decompose, do not raise the limit",
	).toEqual([]);
});

test("line-limit scan has teeth (real tracked .ts population)", () => {
	expect(tracked("*.ts").length).toBeGreaterThan(500);
});

test("tracked .sh files match the pinned allowlist exactly", () => {
	expect(
		tracked("*.sh").sort(),
		"a new .sh needs an explicit entry in tests/law-guards.test.ts (shell-script ban)",
	).toEqual(SH_ALLOWLIST);
});
