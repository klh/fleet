import { type CodexExecCall, codexExecCalls, parseJson } from "./codex-exec.ts";
import type { Json } from "./model.ts";
import { GIT_VALUE_OPTIONS, scriptBucket } from "./shell-readonly.ts";
import {
  basename,
  commandWords,
  MAX_NESTING,
  PIPE,
  quotedWord,
  SHELLS,
  STATEMENT_BREAK,
  skipOptions,
  splitUnquoted,
  stripHeredocBodies,
  unwrapShell,
} from "./shell-text.ts";

export { type CodexExecCall, codexExecCalls } from "./codex-exec.ts";

export const ACTIVITY_BUCKETS = ["context", "planning", "code", "communicating"] as const;
export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

const SHELL_TOOLS = new Set(["bash", "exec_command", "local_shell", "run_shell_command", "shell"]);
const CODE_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "notebookedit",
  "multiedit",
  "write_file",
  "replace",
]);
// Codex polls a long-running `exec_command` (almost always a build or test run)
// through `write_stdin`; the poll carries that command's output and wait. It is
// not an edit, so it stays out of CODE_TOOLS and never moves the phase boundary.
const EXEC_POLL_TOOLS = new Set(["write_stdin"]);
const PLANNING_TOOLS = new Set([
  "enterplanmode",
  "exitplanmode",
  "todowrite",
  "update_plan",
  "write_todos",
  // Claude Code's task list, which replaced TodoWrite.
  "taskcreate",
  "taskupdate",
  "tasklist",
  "taskget",
]);
const SEARCH_COMMANDS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ripgrep",
  "ack",
  "ag",
  "find",
  "fd",
]);
const SEARCH_TOOLS = new Set(["grep", "glob"]);

/** Counts how many search operations a tool call represents: 1 for a
 * structured Grep/Glob call, or one per shell statement whose command is a
 * search binary (rg, grep, find, ...) or `git grep`. Statements are split the
 * way bashBucket splits them, and the command is found the same way, past
 * assignments, wrappers, and `git -C dir`. Only a pipeline's first stage
 * counts: `ps aux | grep node` filters output rather than searching a repo, so
 * counting it would make the code-map suggestion useless. */
export function countSearches(toolName: string, input: string | null): number {
  // Raw name, before localToolName: an MCP server may be named `exec`, and a
  // dotted `mcp__x__y.shell` would otherwise flatten to `shell`.
  if (toolName.startsWith("mcp__")) {
    return 0;
  }
  const inner = codexExecCalls(toolName, input ?? undefined);
  if (inner.length > 0) {
    return inner.reduce(
      (total, call) =>
        total +
        countSearches(
          call.name,
          call.command == null ? null : JSON.stringify({ cmd: call.command }),
        ),
      0,
    );
  }
  const normalized = localToolName(toolName).toLowerCase();
  if (SEARCH_TOOLS.has(normalized)) {
    return 1;
  }
  if (!SHELL_TOOLS.has(normalized)) {
    return 0;
  }
  const script = unwrapShell(commandFromInput(input ?? undefined));
  return script == null ? 0 : scriptSearches(stripHeredocBodies(script), 0);
}

function scriptSearches(script: string, depth: number): number {
  if (depth >= MAX_NESTING) {
    return 0;
  }
  let count = 0;
  for (const statement of splitUnquoted(script, STATEMENT_BREAK)) {
    const [stage = ""] = splitUnquoted(statement, PIPE);
    const words = commandWords(stage);
    const head = basename(words[0] ?? "");
    const args = words.slice(1);
    if (SEARCH_COMMANDS.has(head)) {
      count += 1;
    } else if (head === "git" && skipOptions(args, GIT_VALUE_OPTIONS)[0] === "grep") {
      count += 1;
    } else if (SHELLS.has(head)) {
      // `cd repo && bash -lc "rg x"`: count the searches in the script it runs.
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      const body = flag === -1 ? undefined : args[flag + 1];
      if (body != null) {
        count += scriptSearches(stripHeredocBodies(quotedWord(body) ?? body), depth + 1);
      }
    }
  }
  return count;
}

export function toolBucket(
  toolName: string | null | undefined,
  input?: string | Json,
): ActivityBucket {
  const name = toolName ?? "";
  const inner = codexExecCalls(name, input);
  if (inner.length > 0) {
    const buckets = new Set(inner.map((call) => toolBucket(call.name, innerInput(call))));
    return EXEC_BUCKET_PRECEDENCE.find((bucket) => buckets.has(bucket)) ?? "context";
  }
  if (name.startsWith("mcp__")) {
    return mcpToolBucket(name, input);
  }
  const baseName = localToolName(name);
  const normalized = baseName.toLowerCase();
  if (SHELL_TOOLS.has(normalized)) {
    return bashBucket(commandFromInput(input));
  }
  if (PLANNING_TOOLS.has(normalized)) {
    return "planning";
  }
  if (USER_QUESTION_TOOLS.has(normalized)) {
    return "communicating";
  }
  if (
    CODE_TOOLS.has(normalized) ||
    EXEC_POLL_TOOLS.has(normalized) ||
    NOTE_WRITE_TOOLS.has(normalized)
  ) {
    return "code";
  }
  return "context";
}

/** An MCP tool, named `mcp__<server>__<tool>`: browser, desktop, and REPL
 * servers split into reads and actions; other tools keep the context default. */
function mcpToolBucket(name: string, input: string | Json | undefined): ActivityBucket {
  const match = /^mcp__(.+?)__+(.+)$/.exec(name);
  if (match == null) {
    return "context";
  }
  const server = (match[1] ?? "").toLowerCase();
  const tool = (match[2] ?? "").toLowerCase();
  if (USER_QUESTION_TOOLS.has(tool)) {
    return "communicating";
  }
  if (NOTE_WRITE_TOOLS.has(tool)) {
    return "code";
  }
  return uiToolActs(server, tool, parseToolInput(input)) ? "code" : "context";
}

// Tools that ask the user a question and wait for the answer: the model is
// talking to the user, as it does in visible text.
const USER_QUESTION_TOOLS = new Set([
  "askuserquestion",
  "request_user_input",
  "request_user_input_async",
]);

/** True for a tool that asks the user a question, in any spelling, including
 * an MCP copy such as `mcp__<server>__AskUserQuestion`. Its result arrives
 * when the user answers, so the time before it is the user's. */
export function isUserQuestionTool(
  toolName: string | null | undefined,
  input?: string | Json,
): boolean {
  const inner = codexExecCalls(toolName, input);
  if (inner.length > 0) {
    // A Codex `exec` program that only asks the user something.
    return inner.every((call) => isUserQuestionTool(call.name));
  }
  const name = toolName ?? "";
  const tool = name.startsWith("mcp__")
    ? (/^mcp__.+?__+(.+)$/.exec(name)?.[1] ?? "")
    : localToolName(name);
  return USER_QUESTION_TOOLS.has(tool.toLowerCase());
}
// Tools that write a note or checkpoint outside the workspace: Codex notes, an
// Obsidian vault, a Dosu knowledge entry. Writing is code, but a note is the
// agent's memory rather than the work product, so it never marks the first edit.
const NOTE_WRITE_TOOLS = new Set([
  "notes__write_file",
  "notes__append_to_file",
  "obsidian_append_content",
  "write_knowledge",
]);

// Browser and desktop automation reads when it looks (snapshot, screenshot, page
// text, console, tabs) or goes somewhere (navigate, wait), and acts when it sends
// input or runs code in the page. Hover and mouse moves count as input: they fire
// page handlers and open menus, the same as the click or scroll they lead into.
const PLAYWRIGHT_ACTIONS = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_drag",
  "browser_drop",
  "browser_hover",
  "browser_file_upload",
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
  "browser_resize",
  "browser_emulate_media",
  "browser_handle_dialog",
  "browser_install",
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_move_xy",
]);
const CHROME_ACTIONS = new Set([
  "form_input",
  "file_upload",
  "upload_image",
  "javascript_tool",
  "resize_window",
  "shortcuts_execute",
]);
// Desktop control is all input except these looks and permission checks.
const COMPUTER_READS = new Set([
  "screenshot",
  "zoom",
  "wait",
  "cursor_position",
  "get_app_state",
  "request_access",
  "list_granted_applications",
]);

/** True when a browser, desktop-control, or REPL tool changes state. */
function uiToolActs(server: string, tool: string, input: Json | undefined): boolean {
  if (server.includes("repl")) {
    // A REPL call runs code.
    return true;
  }
  if (tool === "computer") {
    return computerActionActs(get(input, "action"));
  }
  if (tool === "computer_batch" || tool === "browser_batch") {
    const actions = get(input, "actions");
    return (
      Array.isArray(actions) &&
      actions.some((action) =>
        tool === "computer_batch"
          ? computerActionActs(get(action, "action"))
          : uiToolActs(
              server,
              String(get(action, "name") ?? "").toLowerCase(),
              get(action, "input"),
            ),
      )
    );
  }
  if (server.includes("playwright")) {
    return PLAYWRIGHT_ACTIONS.has(tool);
  }
  if (server.includes("chrome")) {
    return CHROME_ACTIONS.has(tool);
  }
  if (/computer[-_]?use/.test(server)) {
    return !COMPUTER_READS.has(tool);
  }
  return false;
}

function computerActionActs(action: Json | undefined): boolean {
  return typeof action === "string" && !COMPUTER_READS.has(action.toLowerCase());
}

function parseToolInput(input: string | Json | undefined): Json | undefined {
  let value = typeof input === "string" ? parseJson(input) : input;
  if (typeof value === "string") {
    value = parseJson(value);
  }
  return value;
}

function get(value: Json | undefined, key: string): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;
}

// High-precision markers that a shell command mutates a source file. Kept
// deliberately narrow: a false positive moves the phase boundary earlier and
// mislabels orientation as implementation, which is worse than missing one. So
// no bare `>` redirect (too often /dev/null, /tmp, logs) -- only unambiguous
// in-place edits, patch application, and explicit file writes.
const SHELL_EDIT_PATTERNS: RegExp[] = [
  /\bgit\s+apply\b(?![^\n]*--(?:check|stat|summary|numstat))/, // apply a patch for real
  /\bsed\b[^\n|]*\s-i\b/, // in-place edit
  /\bpatch\b[^\n|]*-p\d/, // patch -p1 < ...
  /\bwriteFileSync\b|\bfs\.write\b|\.writeFile\b/, // node fs writes (node -e ...)
  /\bopen\([^)]*['"][wa]\+?['"]/, // python open(..., "w"/"a")
  /\.write_(?:text|bytes)\(/, // python pathlib Path.write_text / write_bytes
  /\bapplypatch\b/,
];

/** True for tools that mutate a file on disk (the phase boundary marker): the
 * first such tool_use flips a session from orientation to implementation. Covers
 * the structured edit tools (edit/write/patch) AND shell commands that clearly
 * write a file (git apply, sed -i, fs.writeFileSync, ...), since agents sometimes
 * implement through the shell rather than the edit tool. */
export function isCodeEditTool(
  toolName: string | null | undefined,
  input?: string | Json,
): boolean {
  const inner = codexExecCalls(toolName, input);
  if (inner.length > 0) {
    return inner.some((call) => isCodeEditTool(call.name, innerInput(call)));
  }
  const normalized = localToolName(toolName ?? "").toLowerCase();
  if (CODE_TOOLS.has(normalized)) {
    return true;
  }
  if (SHELL_TOOLS.has(normalized)) {
    const command = commandFromInput(input);
    // The patterns match anywhere in the text, so `rg writeFileSync src` or
    // `sed -n 1p f; grep -i x` would look like edits; an edit is never a read.
    return (
      command != null &&
      SHELL_EDIT_PATTERNS.some((re) => re.test(command)) &&
      bashBucket(command) === "code"
    );
  }
  return false;
}

export function blockBucket(
  blockType: string | null,
  toolName?: string | null,
  input?: string | Json,
): ActivityBucket {
  if (blockType === "thinking") {
    return "planning";
  }
  if (blockType === "tool_use" || blockType === "tool_result" || blockType === "web_search") {
    return toolBucket(toolName, input);
  }
  return "communicating";
}

/** A shell command is context only when every statement and pipeline stage
 * in it is read-only; one mutating or unrecognized part makes it code. Agents
 * routinely chain reads (`cd repo; grep -n x src; sed -n 1,40p f`), so judging
 * the whole command by its first word filed that reading under code. */
export function bashBucket(command: string | null): ActivityBucket {
  const script = unwrapShell(command);
  if (script == null || script.trim() === "") {
    return "code";
  }
  return scriptBucket(stripHeredocBodies(script));
}

function commandFromInput(input: string | Json | undefined): string | null {
  if (input == null) {
    return null;
  }
  let value = typeof input === "string" ? parseJson(input) : input;
  if (typeof value === "string") {
    const nested = parseJson(value);
    if (nested !== value) {
      value = nested;
    }
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const command = value.command ?? value.cmd;
    if (typeof command === "string") {
      return command;
    }
    if (Array.isArray(command)) {
      return command.filter((part): part is string => typeof part === "string").join(" ");
    }
  }
  return null;
}
function localToolName(name: string): string {
  return name.split(".").filter(Boolean).at(-1) ?? name;
}
// A program that reads and then patches is an implementation step, so the strongest
// inner bucket labels the whole call. A program that asks the user is communicating.
const EXEC_BUCKET_PRECEDENCE: ActivityBucket[] = ["code", "planning", "communicating", "context"];

function innerInput(call: CodexExecCall): Json | undefined {
  return call.command == null ? undefined : { cmd: call.command };
}
