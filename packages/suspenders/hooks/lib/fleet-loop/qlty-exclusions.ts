// hooks/lib/fleet-loop/qlty-exclusions.ts — W2590: qlty's OWN exclude set
// as the one admission boundary for merge-time formatting. The first
// `qlty check --fix` pass already honors .qlty/qlty.toml exclude_patterns;
// the cached-biome fallback (merge.ts qltyFixMergedFiles) must not bypass
// it — an excluded generated asset (vendor dirs, min.* assets) never
// reaches a writer. No second ignore list: patterns come from the repo's
// real config, resolved at the repo root — exact parity with what
// `qlty check` invoked at cwd=repo resolves for repo-relative paths
// (merge callers pass the repo root; no nested-path claim beyond that).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// schema law (W1238.4): the tool-owned qlty TOML stays a tool format — the
// slice consumed here is safeParse'd through a named schema. Malformed
// bytes read as UNKNOWN (fail-closed for the unsafe writer), never as a
// silently empty exclusion set.
const QltyConfigSchema = z.object({
	exclude_patterns: z.array(z.string()).optional(),
});
type QltyConfig = z.infer<typeof QltyConfigSchema>;

const configCache = new Map<string, QltyConfig | null | undefined>();

/** Config AT `cfg`: parsed object, null = unreadable/malformed (unknown),
 * undefined = no config there. */
function parseConfig(cfg: string): QltyConfig | null | undefined {
	if (!configCache.has(cfg)) {
		if (!existsSync(cfg)) configCache.set(cfg, undefined);
		else
			try {
				const parsed = QltyConfigSchema.safeParse(
					Bun.TOML.parse(readFileSync(cfg, "utf8")),
				);
				configCache.set(cfg, parsed.success ? parsed.data : null);
			} catch {
				configCache.set(cfg, null);
			}
	}
	return configCache.get(cfg);
}

/** The repo root's .qlty/qlty.toml exclude set — exact parity with what
 * `qlty check` invoked at cwd=repo resolves for repo-relative paths.
 * Absent/malformed/unreadable config → null (fail-closed for the unsafe
 * fallback: without a KNOWN boundary the writer must not run). */
export function qltyExcludePatterns(repo: string): string[] | null {
	const cfg = parseConfig(join(repo, ".qlty", "qlty.toml"));
	if (cfg === undefined || cfg === null) return null;
	return cfg.exclude_patterns ?? [];
}

/** True when `rel` (repo-relative, POSIX separators) hits an exclude
 * pattern. qlty glob semantics: a pattern without "/" matches any path
 * segment/basename (qlty walks these against the full path); a pattern
 * with "/" anchors at repo root. */
export function qltyExcluded(patterns: string[], rel: string): boolean {
	for (const p of patterns) {
		if (p.includes("/")) {
			if (new Bun.Glob(p).match(rel)) return true;
		} else if (new Bun.Glob(p).match(basename(rel))) return true;
		// pattern
	}
	return false;
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
}
