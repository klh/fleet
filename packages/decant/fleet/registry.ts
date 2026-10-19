// fleet/registry.ts — W950 session-source registry (the fleet adapter layer).
//
// Upstream decant hardcodes four session sources in ingest.discover(); the
// W950 seam replaces that with a REGISTRY keyed by the W918 skills-CLI
// target catalog (packages/suspenders/hooks/lib/vendor/skills-agents.ts).
// Each entry names the catalog target id it serves, the decant Tool
// (transcript-format parser) that parses it, and how to resolve the
// target's session dirs on this machine. Detected-but-unadapted catalog
// targets surface through the self-extending miss path
// (fleet/after-sync.ts): every sync mints one adapter item per target.
//
// Upstream purity: with the fleet layer removed, decant runs byte-identical
// to v0.11.0 — the registry composes only upstream's exported discovery API
// (ingest.discoverSourcePaths), never its privates. Parity rules:
//   - decant's own env/flags (DECANT_CLAUDE_DIR, --claude-dir, ...) win
//     first;
//   - the catalog's env names (CLAUDE_CONFIG_DIR, CODEX_HOME) fill where
//     decant has no knob (the W950 lift: more CLIs, same surface);
//   - nothing set → upstream v0.11.0 defaults exactly.
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "../../suspenders/hooks/lib/vendor/skills-agents.ts";
import type { IngestConfig } from "../src/ingest.ts";

/** Path-capable context the resolvers read from (injected for tests). */
export interface HomeCtx {
  home: string;
  /** Process env — decant knobs first, then the catalog's env names. */
  env: Record<string, string | undefined>;
}

/** One registered session source: catalog target id → dirs + format. */
export interface SessionSourceAdapter {
  /** W918 catalog target id (the registry's key). */
  id: AgentType;
  /** Transcript-format adapter: the decant Tool that parses this source. */
  tool: "claude_code" | "codex" | "gemini" | "opencode";
  /** Session-dir candidates; missing dirs are skipped at discovery. */
  dirs: (ctx: HomeCtx, config: IngestConfig) => string[];
}

/** The stock four — dir resolution reads the parity-resolved config values
 * upstream discover() itself uses, so parity holds by construction. */
const stockAdapters: SessionSourceAdapter[] = [
  {
    id: "claude-code",
    tool: "claude_code",
    dirs: (_c, config) => [config.claudeDir],
  },
  {
    id: "codex",
    tool: "codex",
    dirs: (_c, config) => [
      join(config.codexDir, "sessions"),
      join(config.codexDir, "archived_sessions"),
    ],
  },
  {
    id: "gemini-cli",
    tool: "gemini",
    dirs: (_c, config) => (config.geminiDir != null ? [config.geminiDir] : []),
  },
  {
    // OpenCode is config-driven (dir + explicit OPENCODE_DB file); the
    // catalog's opencode entry is the skills config home, not session data.
    id: "opencode",
    tool: "opencode",
    dirs: (_c, config) => {
      const out: string[] = [];
      if (config.opencodeDir != null) out.push(config.opencodeDir);
      if (config.opencodeDb != null && config.opencodeDb !== "") {
        out.push(config.opencodeDb);
      }
      return out;
    },
  },
];

/** Registered extras beyond the stock four (future transcript adapters). */
const extraAdapters: SessionSourceAdapter[] = [];

/** Register a transcript adapter for a non-stock catalog target. */
export function registerSessionSource(adapter: SessionSourceAdapter): void {
  const existing = extraAdapters.findIndex((a) => a.id === adapter.id);
  if (existing >= 0) extraAdapters[existing] = adapter;
  else extraAdapters.push(adapter);
}

/** Every registered source: stock four first, extras in arrival order. */
export function sessionSources(): readonly SessionSourceAdapter[] {
  return [...stockAdapters, ...extraAdapters];
}

/** Build the resolver context from process env (home injectable for tests). */
export function homeCtx(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): HomeCtx {
  return { home, env };
}

/** The registry resolved to a --path-style path list for one config — the
 * value the CLI seam injects into config.sourcePaths when the user gave no
 * explicit --path. Upstream discover() then routes through its own exported
 * discoverSourcePaths() collector, so classification is upstream's own. */
export function sessionSourcePaths(config: IngestConfig, ctx: HomeCtx = homeCtx()): string[] {
  const paths: string[] = [];
  for (const adapter of sessionSources()) {
    paths.push(...adapter.dirs(ctx, config));
  }
  return paths;
}
