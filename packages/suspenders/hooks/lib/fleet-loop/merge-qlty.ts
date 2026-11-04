// fleet-loop/merge-qlty.ts — the W869 merge-time quality floor, relocated
// W2681: the autofix now runs INSIDE the guarded merge (the scratch
// worktree merge-guard.ts owns), before postflight validation and the final
// exact-commit review — the W2270 one-use publish grants admit exactly one
// fast-forward per reviewed publish, so a post-merge fix commit directly
// on main is structurally impossible. The fix commit becomes part of the
// single reviewed, granted, published candidate.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { have } from "../run.ts";

/** Run qlty check --fix over the merged branch's code files, then commit any
 * applied fixes on the worktree HEAD (the guard's scratch checkout) so the
 * published main never carries the lane's deferred cosmetic lint (a
 * completion never runs outside worktrees).
 * Fail-open: no qlty on PATH, no surviving code files, or a broken run never
 * blocks the merge; unfixable issues are counted and logged, never fatal.
 * Returns the new head sha when a fix commit landed, else null. */
export function qltyFixMergedFiles(opts: {
	repo: string;
	branch: string;
	files: string[];
}): { fixed: boolean; head: string | null; left: number } {
	const code = opts.files
		.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
		.filter((f) => existsSync(join(opts.repo, f)));
	if (!code.length || !have("qlty"))
		return { fixed: false, head: null, left: 0 };
	const dec = new TextDecoder();
	const spawn = (cmd: string[]) =>
		Bun.spawnSync(cmd, {
			cwd: opts.repo,
			stdout: "pipe",
			stderr: "pipe",
		});
	const check = spawn([
		"qlty",
		"check",
		"--fix",
		"--no-upgrade-check",
		"--no-progress",
		...code,
	]);
	const out = `${check.stdout ? dec.decode(check.stdout) : ""}${check.stderr ? dec.decode(check.stderr) : ""}`;
	const left = Number(/ISSUES:\s*(\d+)/.exec(out)?.[1] ?? 0);
	// qlty 0.649 reports biome lint fixes without applying them — the write
	// pass goes through the cached biome binary, with the promoted rule set
	// (recommended + noNonNullAssertion) injected via a scratch config.
	if (left > 0) {
		const biome = biomeBin();
		if (biome) {
			const cfgDir = biomeScratchConfig();
			spawn([
				biome,
				"check",
				"--write",
				"--unsafe",
				...(cfgDir ? ["--config-path", cfgDir] : []),
				"--no-errors-on-unmatched",
				...code,
			]);
		}
	}
	const st = spawn(["git", "status", "--porcelain", "--", ...code]);
	const dirty = st.stdout
		.toString()
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => l.slice(3).trim());
	if (!dirty.length) return { fixed: false, head: null, left };
	spawn(["git", "add", "--", ...dirty]);
	const c = spawn([
		"git",
		"commit",
		"-m",
		`${opts.branch}: merge-time qlty autofix (W869)`,
	]);
	if ((c.exitCode ?? 1) !== 0) return { fixed: false, head: null, left };
	return {
		fixed: true,
		head: spawn(["git", "rev-parse", "--short", "HEAD"])
			.stdout.toString()
			.trim(),
		left,
	};
}

/** The qlty-cached biome binary — the only writer that applies biome lint
 * fixes (qlty check --fix reports them without applying, 0.649).
 * SUSPENDERS_BIOME_BIN overrides; null = skip the fix pass (fail-open). */
export function biomeBin(): string | null {
	const envBin = process.env.SUSPENDERS_BIOME_BIN;
	if (envBin) return existsSync(envBin) ? envBin : null;
	try {
		const root = join(process.env.HOME ?? "", ".qlty/cache/tools/biome");
		const versions = readdirSync(root)
			.filter((d) => /^[0-9]/.test(d))
			.sort()
			.reverse();
		for (const v of versions) {
			const bin = join(root, v, "node_modules/@biomejs/biome/bin/biome");
			if (existsSync(bin)) return bin;
		}
	} catch {}
	return null;
}

/** Scratch biome config dir (os tmpdir) carrying the promoted rule set —
 * recommended lints plus noNonNullAssertion, which biome's defaults leave
 * off but the qlty plugin enables. Written once, outside any repo. */
export function biomeScratchConfig(): string | null {
	try {
		const dir = join(tmpdir(), "klh-w869-biome");
		mkdirSync(dir, { recursive: true });
		const cfg = join(dir, "biome.json");
		if (!existsSync(cfg))
			writeFileSync(
				cfg,
				JSON.stringify({
					linter: {
						enabled: true,
						rules: {
							recommended: true,
							style: { noNonNullAssertion: "error" },
						},
					},
				}),
			);
		return dir;
	} catch {
		return null;
	}
}
