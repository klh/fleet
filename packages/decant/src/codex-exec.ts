/** The Codex `exec` program parser: one `exec` tool_use wraps a JavaScript
 * program of `tools.<name>(...)` calls, and each inner call is classified on
 * its own terms. W1238.6.3: moved verbatim from the vendored buckets.ts. */

import { type CallExpression, parse } from "acorn";
import { simple } from "acorn-walk";
import type { Json } from "./model.ts";

export function parseJson(value: string): Json | string {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}
/** One `tools.<name>(...)` call inside a Codex `exec` program. */
export interface CodexExecCall {
  name: string;
  /** The literal `cmd` of an `exec_command` call; null when it is built at runtime. */
  command: string | null;
}

// Recent Codex versions run every action through one `exec` tool whose input is a
// JavaScript program calling `tools.exec_command(...)`, `tools.apply_patch(...)`, and so
// on. Classifying that wrapper by its own name would file every edit and shell command
// as context, so each inner call is classified on its own terms.
function isCodexExec(toolName: string | null | undefined): boolean {
  const name = toolName ?? "";
  // Raw name check: an MCP server's tool may also be called `exec`.
  return !name.startsWith("mcp__") && name.toLowerCase() === "exec";
}

function execProgram(input: string | Json | undefined): string | null {
  if (input == null) {
    return null;
  }
  const parsed = typeof input === "string" ? parseJson(input) : input;
  if (typeof parsed === "string") {
    return parsed;
  }
  return parsed != null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof parsed.input === "string"
    ? parsed.input
    : null;
}

function execCommandArgument(
  argument: CallExpression["arguments"][number] | undefined,
): string | null {
  if (argument?.type !== "ObjectExpression") return null;
  // Later properties win; a spread or computed key may overwrite cmd at runtime.
  for (const property of argument.properties.toReversed()) {
    if (property.type === "SpreadElement" || property.computed) return null;
    const key = property.key;
    if (
      (key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : null) !== "cmd"
    ) {
      continue;
    }
    const value = property.value;
    if (property.kind !== "init") return null;
    if (value.type === "Literal" && typeof value.value === "string") return value.value;
    return value.type === "TemplateLiteral" && value.expressions.length === 0
      ? (value.quasis[0]?.value.cooked ?? null)
      : null;
  }
  return null;
}

/** The inner tool calls of a Codex `exec` program, in source order. Empty for any
 * other tool, or for a program that cannot be parsed or calls no tools. */
export function codexExecCalls(
  toolName: string | null | undefined,
  input?: string | Json,
): CodexExecCall[] {
  if (!isCodexExec(toolName)) {
    return [];
  }
  const program = execProgram(input);
  if (program == null) {
    return [];
  }
  try {
    const ast = parse(program, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
    const calls: (CodexExecCall & { start: number })[] = [];
    simple(ast, {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "tools" ||
          callee.property.type !== "Identifier" ||
          callee.property.name.toLowerCase() === "exec"
        ) {
          return;
        }
        const name = callee.property.name;
        calls.push({
          name,
          command: name === "exec_command" ? execCommandArgument(node.arguments[0]) : null,
          start: node.start,
        });
      },
    });
    return calls.sort((a, b) => a.start - b.start).map(({ name, command }) => ({ name, command }));
  } catch {
    // Invalid or deeply nested source must not crash ingest or invent tool calls.
    return [];
  }
}
