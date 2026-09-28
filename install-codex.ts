#!/usr/bin/env bun
/**
 * speedy-claude — Codex CLI install path (dual-home).
 *
 * Executes the "Porting guide" in docs/codex-setup.md as an idempotent installer:
 *   1. doctrine — symlink ~/.codex/AGENTS.md → ~/.claude/CLAUDE.md
 *   2. skills   — zero-copy symlink ~/.agents/skills → ~/.claude/skills
 *   3. prompts  — commands/*.md → ~/.codex/prompts/<name>.md
 *   4. hooks    — settings.example.json hooks block → ~/.codex/hooks.json
 *                 (matchers gain apply_patch; Codex edits files via apply_patch)
 *   5. config   — ~/.codex/config.toml marked regions: project_doc_* keys,
 *                 permissions profile (beta), mcp_servers from .mcp.json
 *   6. agents   — agents/*.md personas → ~/.codex/agents/*.toml (developer_instructions)
 *
 * Deliberately NOT ported (docs/codex-setup.md §8): custom statuslines, z.ai provider
 * routing (wire_api responses-only), the suspenders session data plane.
 *
 * Usage:
 *   bun install-codex.ts [--dry-run]
 *     [--skip-doctrine] [--skip-skills] [--skip-prompts] [--skip-hooks]
 *     [--skip-agents] [--skip-mcp] [--skip-permissions]
 *
 * Env overrides (testing / non-standard homes): CODEX_HOME, SPEEDY_CLAUDE_HOME, HOME.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

// ─── Roots ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? homedir();
const CODEX_HOME = process.env.CODEX_HOME ?? join(HOME, ".codex");
const CLAUDE_HOME = process.env.SPEEDY_CLAUDE_HOME ?? join(HOME, ".claude");
const REPO = import.meta.dir;

// ─── Args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skip = new Set<string>();
for (const a of argv) {
  const m = a.match(/^--skip-([a-z-]+)$/);
  if (m?.[1]) skip.add(m[1]);
}

// ─── Output helpers ───────────────────────────────────────────────────────────

const warnings: string[] = [];
function warn(msg: string): void {
  warnings.push(msg);
  console.log(`  ⚠ ${msg}`);
}
function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}
function act(desc: string, fn: () => void): void {
  if (dryRun) {
    console.log(`  · [dry] ${desc}`);
    return;
  }
  fn();
  ok(desc);
}

// ─── Shared file helpers ──────────────────────────────────────────────────────

function mkdirp(p: string): void {
  mkdirSync(p, { recursive: true });
}

/** Create/repoint linkPath → target. Never touches a non-symlink existing file. */
function ensureSymlink(linkPath: string, target: string, desc: string): void {
  let st;
  try {
    st = lstatSync(linkPath);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    const cur = readlinkSync(linkPath);
    if (cur === target) {
      ok(`${desc} — already ${linkPath} → ${target}`);
      return;
    }
    act(`${desc} — repoint ${linkPath}: ${cur} → ${target}`, () => {
      rmSync(linkPath);
      symlinkSync(target, linkPath);
    });
    return;
  }
  if (st) {
    warn(
      `${linkPath} exists and is not a symlink — left untouched (remove it to adopt speedy)`,
    );
    return;
  }
  act(`${desc} — link ${linkPath} → ${target}`, () => {
    mkdirp(dirname(linkPath));
    symlinkSync(target, linkPath);
  });
}

function tomlStr(v: unknown): string {
  // JSON string escaping is TOML basic-string compatible (\", \\, \n, \uXXXX).
  return JSON.stringify(String(v));
}

// ─── 1. Doctrine: ~/.codex/AGENTS.md → ~/.claude/CLAUDE.md ────────────────────

function stepDoctrine(): void {
  console.log("\n[1/6] doctrine (~/.codex/AGENTS.md)");
  const target = join(CLAUDE_HOME, "CLAUDE.md");
  if (!existsSync(target)) {
    warn(
      `${target} not found — run install.sh first, or re-run with the doctrine present`,
    );
    return;
  }
  ensureSymlink(join(CODEX_HOME, "AGENTS.md"), target, "global doctrine");
}

// ─── 2. Skills: ~/.agents/skills → ~/.claude/skills (zero-copy) ───────────────

function stepSkills(): void {
  console.log("\n[2/6] skills (~/.agents/skills, symlink-followed)");
  let target = join(CLAUDE_HOME, "skills");
  if (!existsSync(target)) {
    target = join(REPO, "skills");
    warn(`${CLAUDE_HOME}/skills missing — falling back to repo skills/`);
  }
  ensureSymlink(join(HOME, ".agents", "skills"), target, "skills (zero-copy)");
}

// ─── 3. Prompts: commands/*.md → ~/.codex/prompts/ ────────────────────────────

const PROMPT_MARKER = "<!-- speedy-claude managed — source: commands/";

function stepPrompts(): void {
  console.log("\n[3/6] prompts (~/.codex/prompts, /prompts:<name>)");
  const srcDir = join(REPO, "commands");
  if (!existsSync(srcDir)) {
    warn(`${srcDir} not found — skipping prompts`);
    return;
  }
  mkdirp(join(CODEX_HOME, "prompts"));
  for (const f of readdirSync(srcDir).sort()) {
    if (!f.endsWith(".md")) continue;
    const src = join(srcDir, f);
    const dst = join(CODEX_HOME, "prompts", f);
    const existing = existsSync(dst) ? readFileSync(dst, "utf8") : null;
    if (existing && !existing.includes(PROMPT_MARKER)) {
      warn(`prompts/${f} exists and is not speedy-managed — left untouched`);
      continue;
    }
    const body = readFileSync(src, "utf8").replace(/\s+$/, "");
    const content = `${body}\n\n${PROMPT_MARKER}${f} (docs/codex-setup.md §3) -->\n`;
    act(`prompts/${f}`, () => writeFileSync(dst, content));
  }
}

// ─── 4. Hooks: settings.example.json → ~/.codex/hooks.json ────────────────────

function stepHooks(): void {
  console.log("\n[4/6] hooks (~/.codex/hooks.json)");
  const settingsPath = join(REPO, "settings.example.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: Record<string, { matcher?: string; hooks: unknown[] }[]>;
  };
  if (!settings.hooks) {
    warn("settings.example.json has no hooks block — skipping");
    return;
  }
  // Codex edits files via apply_patch — extend file-tool matchers to catch it.
  const translated = Object.fromEntries(
    Object.entries(settings.hooks).map(([event, groups]) => [
      event,
      groups.map((g) => {
        let matcher = g.matcher;
        if (
          matcher &&
          /\b(Edit|Write|MultiEdit|NotebookEdit)\b/.test(matcher) &&
          !matcher.includes("apply_patch")
        ) {
          matcher = `${matcher}|apply_patch`;
        }
        return { ...g, matcher };
      }),
    ]),
  );
  const content = `${JSON.stringify({ hooks: translated }, null, 2)}\n`;
  const dst = join(CODEX_HOME, "hooks.json");
  if (existsSync(dst)) {
    if (readFileSync(dst, "utf8") === content) {
      ok("hooks.json — already up to date");
      return;
    }
    warn(
      `${dst} exists and differs from the generated version — left untouched (delete it to re-adopt)`,
    );
    return;
  }
  act(
    `hooks.json (${Object.keys(translated).length} events, matchers +apply_patch)`,
    () => writeFileSync(dst, content),
  );
  console.log(
    "    next: run `codex` → /hooks and trust each definition (hash-pinned)",
  );
}

// ─── 5. config.toml: marked regions ───────────────────────────────────────────

const REGION_BEGIN = "# >>> speedy-claude >>>";
const REGION_END = "# <<< speedy-claude <<<";
const REGION_RE = new RegExp(
  `${REGION_BEGIN}[^\\n]*\\n[\\s\\S]*?${REGION_END}\\n?`,
  "g",
);

interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  bearer_token_env_var?: string;
}

function mcpServerToToml(id: string, s: McpServer): string {
  const lines = [`[mcp_servers.${id}]`];
  if (s.command) lines.push(`command = ${tomlStr(s.command)}`);
  if (s.args) lines.push(`args = [${s.args.map(tomlStr).join(", ")}]`);
  if (s.cwd) lines.push(`cwd = ${tomlStr(s.cwd)}`);
  if (s.env) {
    const entries = Object.entries(s.env).map(
      ([k, v]) => `${k} = ${tomlStr(v)}`,
    );
    if (entries.length > 0) lines.push(`env = { ${entries.join(", ")} }`);
  }
  if (s.url) lines.push(`url = ${tomlStr(s.url)}`);
  if (s.bearer_token_env_var)
    lines.push(`bearer_token_env_var = ${tomlStr(s.bearer_token_env_var)}`);
  return lines.join("\n");
}

function stepConfig(): void {
  console.log("\n[5/6] config (~/.codex/config.toml marked regions)");
  const mcpPath = join(REPO, ".mcp.json");
  const mcp = existsSync(mcpPath)
    ? ((
        JSON.parse(readFileSync(mcpPath, "utf8")) as {
          mcpServers?: Record<string, McpServer>;
        }
      ).mcpServers ?? {})
    : {};

  const wantPermissions = !skip.has("permissions");
  const wantMcp = !skip.has("mcp");

  const docLines = [
    "# Added by speedy-claude (bun install-codex.ts) — docs/codex-setup.md §1",
    'project_doc_fallback_filenames = ["CLAUDE.md", "AGENTS.md"]',
    "project_doc_max_bytes = 65536",
  ];

  // Built AFTER collision scans against user-owned content.
  let bottom = "";

  return act(`config.toml (${CODEX_HOME}/config.toml)`, () => {
    const path = join(CODEX_HOME, "config.toml");
    const exists = existsSync(path);
    const original = exists ? readFileSync(path, "utf8") : "";
    // Strip our previous regions, keep the user's own content for re-scanning.
    const user = original.replace(REGION_RE, "").replace(/\s+$/, "");
    const hadRegions = original.includes(REGION_BEGIN);

    // Duplicate-key / non-composing guards (scan user-owned content only).
    const hasKey = (k: string): boolean =>
      new RegExp(`^\\s*${k}\\s*=`, "m").test(user);
    const hasTable = (t: string): boolean =>
      new RegExp(`^\\[${t.replace(/\./g, "\\.")}\\]`, "m").test(user);

    if (wantPermissions) {
      if (hasKey("default_permissions") || hasTable("permissions.speedy")) {
        warn(
          "config already defines permissions profile — speedy profile not installed",
        );
      } else if (/^\s*sandbox_mode\s*=/m.test(user)) {
        warn(
          "config sets sandbox_mode — permission profiles do not compose; skipped",
        );
      } else {
        docLines.push('default_permissions = "speedy"');
        bottom += [
          "# speedy-claude permission posture — docs/codex-setup.md §6 (beta)",
          "[permissions.speedy]",
          'extends = ":workspace"',
          "",
          "[permissions.speedy.filesystem]",
          '"**/*.env"        = "deny"',
          '"**/credentials*" = "deny"',
          '"**/*.pem"        = "deny"',
          "",
        ].join("\n");
      }
    }

    if (wantMcp) {
      for (const [id, s] of Object.entries(mcp)) {
        if (hasTable(`mcp_servers.${id}`)) {
          warn(`[mcp_servers.${id}] already defined — skipped`);
          continue;
        }
        // .mcp.json targets Claude Code's serena context; Codex gets its own.
        const t =
          s.command === "serena"
            ? {
                ...s,
                args: s.args?.map((a) => (a === "claude-code" ? "codex" : a)),
              }
            : s;
        bottom += `${mcpServerToToml(id, t)}\n\n`;
      }
    }

    const top = `${REGION_BEGIN} (top-level keys — must precede any [table])\n${docLines.join("\n")}\n${REGION_END}`;
    const bottomRegion = bottom
      ? `${REGION_BEGIN} (tables)\n${bottom.replace(/\n+$/, "")}\n${REGION_END}`
      : null;

    let next = user;
    if (hadRegions || user.length === 0) {
      // Regions live at the edges; reinsert after stripping our old edge whitespace.
      next = `${top}\n${user.replace(/^\n+/, "")}`;
    } else {
      next = `${top}\n\n${user}`;
    }
    if (bottomRegion) next = `${next.replace(/\n+$/, "")}\n\n${bottomRegion}\n`;

    mkdirp(CODEX_HOME);
    if (exists && !hadRegions) copyFileSync(path, `${path}.pre-speedy`);
    writeFileSync(path, next);
  });
}

// ─── 6. Agents: personas → ~/.codex/agents/*.toml ─────────────────────────────

const AGENT_MARKER = "# speedy-claude managed — generated from agents/";
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

function agentToml(file: string): string | null {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!m[2] || !fm.name || !fm.description) return null;

  const lines = [
    `${AGENT_MARKER}${basename(file).replace(/\.md$/, "")} (docs/codex-setup.md §5)`,
    `name = ${tomlStr(fm.name)}`,
    `description = ${tomlStr(fm.description)}`,
  ];
  if (fm.effort && VALID_EFFORTS.has(fm.effort)) {
    lines.push(`model_reasoning_effort = ${tomlStr(fm.effort)}`);
  }
  // Claude `model:` (sonnet/haiku/opus) intentionally not mapped — Codex model
  // names differ; leave Codex defaults (or [agents] globals) in charge.
  const body = m[2].trim().replace(/'''/g, "''");
  lines.push("", "developer_instructions = '''", body, "'''", "");
  return lines.join("\n");
}

function stepAgents(): void {
  console.log("\n[6/6] agents (~/.codex/agents/*.toml)");
  const srcDir = join(REPO, "agents");
  const dstDir = join(CODEX_HOME, "agents");
  if (!existsSync(srcDir)) {
    warn(`${srcDir} not found — skipping agents`);
    return;
  }
  mkdirp(dstDir);
  let converted = 0;
  for (const f of readdirSync(srcDir).sort()) {
    if (!f.endsWith(".md")) continue;
    const toml = agentToml(join(srcDir, f));
    if (!toml) {
      warn(`agents/${f}: no name/description frontmatter — skipped`);
      continue;
    }
    const name = f.replace(/\.md$/, "");
    const dst = join(dstDir, `${name}.toml`);
    if (
      existsSync(dst) &&
      !readFileSync(dst, "utf8").startsWith(AGENT_MARKER)
    ) {
      warn(
        `agents/${name}.toml exists and is not speedy-managed — left untouched`,
      );
      continue;
    }
    act(`agents/${name}.toml`, () => writeFileSync(dst, toml));
    converted++;
  }
  ok(`${converted} persona(s) converted`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`speedy-claude → Codex dual-home installer`);
console.log(`  CODEX_HOME=${CODEX_HOME}${dryRun ? "  (dry run)" : ""}`);

if (Bun.which("codex")) {
  ok(`codex CLI found: ${Bun.which("codex")}`);
} else {
  warn(
    "codex CLI not on PATH — config written anyway (install Codex CLI to use it)",
  );
}

const steps: [string, () => void][] = [
  ["doctrine", stepDoctrine],
  ["skills", stepSkills],
  ["prompts", stepPrompts],
  ["hooks", stepHooks],
  ["config", stepConfig],
  ["agents", stepAgents],
];
for (const [name, fn] of steps) {
  if (skip.has(name)) {
    console.log(
      `\n[${steps.findIndex((s) => s[0] === name) + 1}/6] ${name} — skipped by flag`,
    );
    continue;
  }
  fn();
}

console.log(
  `\nDone.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ""}`,
);
console.log("Verify (docs/codex-setup.md checklist):");
console.log("  codex status");
console.log(
  '  codex --ask-for-approval never "Summarize the current instructions."',
);
console.log("  /skills   # 36 skills visible");
console.log("  /hooks    # trust each speedy gate");
console.log("  /agent    # personas listed");
console.log(
  "Not ported by design: statusline scripts, z.ai provider routing, suspenders session data plane.",
);
