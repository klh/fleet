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

// W711 (W694 M5/M6): the UI-law gate (hooks/gates/files.ts) only sees
// Write/Edit payloads; this scan sees every tracked code file at CI time.
// HTML-string DOM writes are NEVER allowed; module code and script tags
// must load from the repo (offline LAN), never a CDN.
// The vendored third-party bundles under /vendor/ are the pinned exception.
const UI_LAW_PATTERNS: Array<[RegExp, string]> = [
	[/\.innerHTML\s*\+?=/, ".innerHTML= — never HTML-string DOM writes"],
	[/\.outerHTML\s*\+?=/, ".outerHTML= — never HTML-string DOM writes"],
	[/document\.write\s*\(/, "document.write("],
	[/insertAdjacentHTML\s*\(/, "insertAdjacentHTML("],
	[/(?:import|from)\s*\(?\s*["']https?:/, "remote module import — vendor it, never CDN"],
];
const UI_LAW_HTML_PATTERNS: Array<[RegExp, string]> = [
	[/<script[^>]+src=["']https?:/, "remote <script src> — vendor it, never CDN"],
];
const UI_LAW_ALLOWLIST = [/\/vendor\//, /^tests\/law-guards\.test\.ts$/];
const UI_LAW_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.html", "*.htm", "*.svg"];

function tracked(...patterns: string[]): string[] {
	const out = Bun.spawnSync(["git", "ls-files", ...patterns], { cwd: ROOT });
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

test("no tracked code file writes HTML strings into the DOM or imports from a CDN", () => {
	const offenders: string[] = [];
	for (const f of tracked(...UI_LAW_GLOBS)) {
		if (UI_LAW_ALLOWLIST.some((re) => re.test(f))) continue;
		const text = readFileSync(join(ROOT, f), "utf8");
		const pats = /\.html?$/.test(f)
			? UI_LAW_PATTERNS.concat(UI_LAW_HTML_PATTERNS)
			: UI_LAW_PATTERNS;
		for (const [re, why] of pats) {
			if (re.test(text)) offenders.push(`${f}: ${why}`);
		}
	}
	expect(offenders, "UI law: HTML-string DOM writes and CDN imports are never allowed").toEqual([]);
});

test("UI-law scan has teeth (real tracked code population)", () => {
	expect(tracked(...UI_LAW_GLOBS).length).toBeGreaterThan(500);
});
