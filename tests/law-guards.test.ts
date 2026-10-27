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
import {
	LINE_LIMIT_EXEMPT,
	lineLimitExemption,
} from "../packages/suspenders/hooks/lib/line-limit-exempt.ts";

const ROOT = join(import.meta.dir, "..");
// Vendored-snapshot exemption rows (W1300) live in LINE_LIMIT_EXEMPT — the
// teeth test below keeps them honest; a byte-pure upstream file over the cap
// is exempt ONLY while tracked, over-cap, and argued there.
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
	[
		/(?:import|from)\s*\(?\s*["']https?:/,
		"remote module import — vendor it, never CDN",
	],
];
const UI_LAW_HTML_PATTERNS: Array<[RegExp, string]> = [
	[/<script[^>]+src=["']https?:/, "remote <script src> — vendor it, never CDN"],
];
const UI_LAW_ALLOWLIST = [/\/vendor\//, /^tests\/law-guards\.test\.ts$/];
const UI_LAW_GLOBS = [
	"*.ts",
	"*.tsx",
	"*.js",
	"*.jsx",
	"*.mjs",
	"*.cjs",
	"*.html",
	"*.htm",
	"*.svg",
];

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
				[f, readFileSync(join(ROOT, f), "utf8").split("\n").length] as const,
		)
		.filter(([f, n]) => n > LINE_LIMIT && !lineLimitExemption(f));
	expect(
		over.map(([f, n]) => `${f}: ${n} > ${LINE_LIMIT}`),
		"files over the 1500-line law — decompose, do not raise the limit (vendored-snapshot rows: LINE_LIMIT_EXEMPT)",
	).toEqual([]);
});

test("line-limit scan has teeth (real tracked .ts population)", () => {
	expect(tracked("*.ts").length).toBeGreaterThan(500);
});

test("1500-law vendor exemptions stay argued and current (W1300)", () => {
	for (const row of LINE_LIMIT_EXEMPT) {
		// tracked + still over the cap — an exemption for a split-away or
		// shrunk file is stale: delete the row, never accumulate.
		expect(
			tracked(row.path),
			`${row.path}: exemption row for an untracked file — delete the row`,
		).toEqual([row.path]);
		const n = readFileSync(join(ROOT, row.path), "utf8").split("\n").length;
		expect(
			n > LINE_LIMIT,
			`${row.path}: ${n} lines, at/under the cap — exemption stale, delete the row`,
		).toBe(true);
		// the row must argue both halves: why no local rewrite + where the
		// size reconciles upstream (same argument shape as SH_ALLOWLIST).
		expect(row.why.length).toBeGreaterThan(20);
		expect(row.upstream.length).toBeGreaterThan(20);
	}
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
	expect(
		offenders,
		"UI law: HTML-string DOM writes and CDN imports are never allowed",
	).toEqual([]);
});

test("UI-law scan has teeth (real tracked code population)", () => {
	expect(tracked(...UI_LAW_GLOBS).length).toBeGreaterThan(500);
});

// W902 — hub clocks drift: no fleet surface renders a bare local time.
// toLocaleTimeString()/toLocaleTimeString-adjacent locale-default renders
// are exactly that; the ONE dual-stamp vocabulary (UTC Z + local twin,
// hooks/lib/wallclock.ts) is the only allowed absolute-time form. Storage
// stays epoch-ms. The vendored third-party bundles are the pinned exception.
const WALLCLOCK_PATTERNS: Array<[RegExp, string]> = [
	[/toLocaleTimeString\s*\(/, "toLocaleTimeString("],
	[
		/\.toLocaleString\s*\(\s*\)/,
		"bare .toLocaleString() — locale-default Date render",
	],
];

test("no tracked code file renders a bare local time without its UTC twin (W902)", () => {
	const offenders: string[] = [];
	for (const f of tracked(...UI_LAW_GLOBS)) {
		if (UI_LAW_ALLOWLIST.some((re) => re.test(f))) continue;
		const text = readFileSync(join(ROOT, f), "utf8");
		for (const [re, why] of WALLCLOCK_PATTERNS) {
			if (re.test(text)) offenders.push(`${f}: ${why}`);
		}
	}
	expect(
		offenders,
		"W902 wall-clock law: UTC Z first, local twin beside it (hooks/lib/wallclock.ts)",
	).toEqual([]);
});

test("W902 wall-clock scan has teeth (patterns fire on the banned forms)", () => {
	const samples = [
		"new Date(x).toLocaleTimeString()",
		"new Date(x).toLocaleString()",
	];
	for (const [re] of WALLCLOCK_PATTERNS)
		expect(
			samples.some((s) => re.test(s)),
			`${re} matches none of the banned forms`,
		).toBe(true);
});

// W828 — the Fleet personal-use license perimeter, CI face. The fleet tree
// must stay clear of third-party restrictions incompatible with its license:
// (L6) every installed
// dependency (the post-install truth of bun.lock) classifies permissive
// — copyleft and unknown/missing fail the build; (L7) every committed
// third-party bundle keeps its license banner. Both ride the ONE
// classification in packages/suspenders/hooks/lib/fleet-loop/license-audit.ts.
import {
	classifyLicense,
	PERMISSIVE,
	verifyVendorHeaders,
	walkLicenses,
} from "../packages/suspenders/hooks/lib/fleet-loop/license-audit.ts";

test("installed dependencies stay permissive (Fleet personal-use license perimeter)", () => {
	const rows = walkLicenses(ROOT);
	expect(
		rows.length,
		"license walk found no packages — bun install before test",
	).toBeGreaterThan(0);
	const bad = rows.filter((r) => r.cls !== "permissive");
	expect(
		bad.map((r) => `${r.name}@${r.version}: ${r.license} (${r.cls})`),
		"copyleft/unknown dependency licenses violate the Fleet license perimeter",
	).toEqual([]);
});

test("classifyLicense knows the allowlist (license guard has teeth)", () => {
	expect(classifyLicense("MIT")).toBe("permissive");
	expect(classifyLicense("GPL-3.0-only")).toBe("copyleft");
	expect(classifyLicense("")).toBe("unknown");
	expect(PERMISSIVE.length).toBeGreaterThan(5);
});

test("vendored third-party bundles keep their license banners", () => {
	const rows = verifyVendorHeaders(ROOT);
	const missing = rows.filter((r) => r.header === "missing");
	expect(
		missing.map((r) => `${r.path} (${r.license})`),
		"re-add the license banner or drop the bundle",
	).toEqual([]);
	expect(rows.length).toBeGreaterThanOrEqual(8);
});
