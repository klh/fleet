import type { Stats } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, basename as pathBasename } from "node:path";
import {
  discoverOpenCode,
  isOpenCodeDatabaseName,
  openCodeDatabasePaths,
} from "./ingest-opencode.ts";
import type { IngestConfig, SourceFile } from "./ingest-shared.ts";
import { asString, get } from "./json.ts";
import type { Json, Tool } from "./model.ts";
import { compareCodePoints } from "./order.ts";

export function discover(config: IngestConfig): SourceFile[] {
  if (config.sourcePaths != null && config.sourcePaths.length > 0) {
    return discoverSourcePaths(config.sourcePaths);
  }

  const out: SourceFile[] = [];
  collect(config.claudeDir, "claude_code", false, isSessionJsonl, out);
  collect(join(config.codexDir, "sessions"), "codex", false, isCodexRollout, out);
  collect(join(config.codexDir, "archived_sessions"), "codex", true, isCodexRollout, out);
  if (config.geminiDir != null) {
    collectGemini(config.geminiDir, out);
  }
  out.push(...discoverOpenCode(openCodeDatabasePaths(config)));
  return out;
}

export function discoverSourcePaths(paths: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  const databases: string[] = [];
  for (const path of paths) {
    collectSourcePath(path, out, databases);
  }
  return [...dedupeSourceFiles(out), ...discoverOpenCode(databases)];
}

function collect(
  root: string,
  tool: Tool,
  archived: boolean,
  want: (name: string) => boolean,
  out: SourceFile[],
): void {
  if (!existsSync(root)) {
    return;
  }
  for (const path of walk(root)) {
    const name = pathBasename(path);
    if (want(name)) {
      out.push({ tool, path, archived });
    }
  }
}

function collectSourcePath(path: string, out: SourceFile[], databases: string[]): void {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }

  if (stats.isFile()) {
    if (path.endsWith(".db")) {
      databases.push(path);
      return;
    }
    const source = sourceFileForPath(path);
    if (source != null) {
      out.push(source);
    }
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  for (const child of walk(path)) {
    if (isOpenCodeDatabaseName(pathBasename(child))) {
      databases.push(child);
      continue;
    }
    const source = sourceFileForPath(child);
    if (source != null) {
      out.push(source);
    }
  }
}

function sourceFileForPath(path: string): SourceFile | null {
  const name = pathBasename(path);
  if (!isSessionJsonl(name) || name === "session_index.jsonl") {
    return null;
  }
  if (isCodexRollout(name)) {
    return { tool: "codex", path, archived: hasPathSegment(path, "archived_sessions") };
  }
  if (geminiSessionLayout(path) != null) {
    return { tool: "gemini", path, archived: false };
  }
  return { tool: "claude_code", path, archived: false };
}

function dedupeSourceFiles(files: SourceFile[]): SourceFile[] {
  const seen = new Set<string>();
  const unique: SourceFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) {
      continue;
    }
    seen.add(file.path);
    unique.push(file);
  }
  return unique;
}

/** Claude Code also writes non-session JSONL into the projects tree; the only
 * one today is the dynamic-workflow orchestration journal
 * (subagents/workflows/<runId>/journal.jsonl). Session transcripts are
 * <uuid>.jsonl mains and agent-*.jsonl subagents, which must keep flowing. */
function isSessionJsonl(name: string): boolean {
  return name.endsWith(".jsonl") && name !== "journal.jsonl";
}

interface GeminiSessionLayout {
  chatsDir: string;
  /** Parent chat id when the file is a subagent transcript nested under it. */
  parentSessionId: string | null;
}

function collectGemini(geminiDir: string, out: SourceFile[]): void {
  if (!existsSync(geminiDir)) {
    return;
  }
  for (const path of walk(geminiDir)) {
    if (geminiSessionLayout(path) != null) {
      out.push({ tool: "gemini", path, archived: false });
    }
  }
}

/** Gemini CLI writes chats to `<project>/chats/session-<ts>-<hash>.jsonl` and
 * subagent chats to `<project>/chats/<parent-session-id>/<session-id>.jsonl`.
 * Requiring the `chats` segment keeps `--path` and directory discovery from
 * claiming a Claude Code file that merely starts with `session-`. */
export function geminiSessionLayout(path: string): GeminiSessionLayout | null {
  const name = pathBasename(path);
  if (!name.endsWith(".jsonl")) {
    return null;
  }
  const parent = dirname(path);
  if (pathBasename(parent) === "chats") {
    return name.startsWith("session-") ? { chatsDir: parent, parentSessionId: null } : null;
  }
  const grandparent = dirname(parent);
  if (pathBasename(grandparent) === "chats") {
    return { chatsDir: grandparent, parentSessionId: pathBasename(parent) };
  }
  return null;
}

/** Returns the absolute workspace root recorded beside the project's chats. */
export function geminiProjectPath(layout: GeminiSessionLayout | null): string | null {
  if (layout == null) {
    return null;
  }
  const rootFile = join(dirname(layout.chatsDir), ".project_root");
  try {
    const root = readFileSync(rootFile, "utf8").trim();
    if (root !== "") {
      return root;
    }
  } catch {
    // The hash-named cache directory is not a usable project identity.
  }
  return null;
}

function isCodexRollout(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function hasPathSegment(path: string, segment: string): boolean {
  return path.split(/[\\/]+/).includes(segment);
}

export function readClaudeSidecarMeta(path: string): Json | null {
  if (!path.endsWith(".jsonl")) {
    return null;
  }
  const metaPath = `${path.slice(0, -".jsonl".length)}.meta.json`;
  let content: string;
  try {
    content = readFileSync(metaPath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(content) as Json;
  } catch {
    return null;
  }
}

function walk(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    compareCodePoints(left.name, right.name),
  );
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

export function codexTitles(config: IngestConfig): Map<string, string> {
  const titles = new Map<string, string>();
  const path = join(config.codexDir, "session_index.jsonl");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return titles;
  }
  for (const line of content.split(/\n/)) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const value = JSON.parse(line) as Json;
      const id = asString(get(value, "id"));
      const threadName = asString(get(value, "thread_name"));
      if (id != null && threadName != null) {
        titles.set(id, threadName);
      }
    } catch {
      // Corrupt session-index rows should not make session ingest fail.
    }
  }
  return titles;
}

export function fileStem(path: string): string {
  const base = pathBasename(path);
  const ext = extname(base);
  return ext === "" ? base : base.slice(0, -ext.length);
}
