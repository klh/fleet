/** Shell-text machinery behind the activity buckets: statement/word splitting
 * that respects quotes, escapes, substitutions, and heredocs, plus command-word
 * parsing past assignments, control keywords, and wrappers. W1238.6.3: moved
 * verbatim from the vendored buckets.ts. */

export {
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
  stripQuoted,
  substitutions,
  unquote,
  unwrapShell,
};

// Keywords and wrappers that run the words after them: classify those words.
const COMMAND_PREFIXES = new Set(["if", "elif", "then", "else", "while", "until", "do", "!", "{"]);
const COMMAND_WRAPPERS = new Set(["time", "nohup", "timeout", "xargs"]);
// Wrapper options whose value is the next word, so it is not mistaken for the command.
const WRAPPER_VALUE_OPTIONS = new Set(["-k", "-s", "-I", "-n", "-P", "-L", "-d", "-E", "-u", "-C"]);
// `bash -lc "<script>"` and friends: classify the script, not the shell.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]*?)\s*$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
// Command substitutions and `sh -c` scripts nest; past this depth a command is
// treated as unrecognized (code) rather than parsed further.
const MAX_NESTING = 8;
const STATEMENT_BREAK = /\n|;|&&|\|\||&(?!>)/y;
const PIPE = /\|&?(?!\|)/y;
const WORD_BREAK = /\s+/y;

/** Splits on `separator` (a sticky regex) outside quotes, escapes, and
 * `$(...)`, so a grep pattern like "a\\|b", a sed script like 's/a;b/c/',
 * `find -exec cat {} \;`, or `$(git log | head -1)` stays one piece. */
function splitUnquoted(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote != null) {
      if (char === "\\" && quote === '"') {
        current += char + (text[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if ("$<>".includes(char) && text[i + 1] === "(") {
      depth += 1;
      current += `${char}(`;
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
      current += char;
      continue;
    }
    // `>&2` and `|&` are not a backgrounding `&`.
    const redirect = char === "&" && "<>|".includes(text[i - 1] ?? "");
    separator.lastIndex = i;
    const match = redirect ? null : separator.exec(text);
    if (match != null) {
      parts.push(current);
      current = "";
      i += match[0].length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** The bodies of `$(...)` substitutions outside single quotes, and of `<(...)`
 * and backtick substitutions outside any quotes. Arithmetic `$((...))` runs
 * nothing and is skipped. */
function substitutions(statement: string): string[] {
  const bodies: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i] ?? "";
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "'" && quote == null) {
      quote = "'";
    } else if (char === '"') {
      quote = quote == null ? '"' : null;
    } else if (char === "$" && statement.startsWith("((", i + 1)) {
      // Arithmetic runs nothing itself, but a `$(...)` inside it still runs.
      i += 2;
    } else if ((char === "$" || (char === "<" && quote == null)) && statement[i + 1] === "(") {
      let depth = 1;
      let end = i + 2;
      for (; end < statement.length && depth > 0; end += 1) {
        if (statement[end] === "(") {
          depth += 1;
        } else if (statement[end] === ")") {
          depth -= 1;
        }
      }
      bodies.push(statement.slice(i + 2, depth === 0 ? end - 1 : end));
      i = end - 1;
    } else if (char === "`" && quote == null) {
      // Inside double quotes a backtick pair is almost always a Markdown code
      // span in a grep pattern or label, not a command the agent meant to run.
      const end = statement.indexOf("`", i + 1);
      if (end === -1) {
        break;
      }
      bodies.push(statement.slice(i + 1, end));
      i = end;
    }
  }
  return bodies;
}

const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g;

/** Drops heredoc bodies so their lines are not read as statements. The line
 * that opens the heredoc still decides: `cat > f <<EOF` writes, `python3 - <<EOF`
 * runs code, and a bare `cat <<EOF` only prints. An unterminated heredoc keeps
 * the script intact rather than hiding what follows it. */
function stripHeredocBodies(script: string): string {
  if (!script.includes("<<")) {
    return script;
  }
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of script.split("\n")) {
    if (pending.length > 0) {
      if (line.replace(/^\t+/, "").trimEnd() === pending[0]) {
        pending.shift();
      }
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(HEREDOC)) {
      if (outsideQuotes(line, match.index ?? 0)) {
        pending.push(match[2] ?? "");
      }
    }
  }
  return pending.length > 0 ? script : kept.join("\n");
}

function outsideQuotes(text: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i += 1) {
    const char = text[i] ?? "";
    if (quote == null && char === "\\") {
      i += 1;
    } else if (quote == null && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    }
  }
  return quote == null;
}

// Escapes go first so `\"` does not open a quote, and an unterminated quote
// runs to the end, as it does in splitUnquoted (a closing quote is optional so
// an unbalanced string cannot make this quadratic). Arithmetic goes too, since
// `$((a > b))` compares rather than redirects.
function stripQuoted(text: string): string {
  return text.replace(
    /\\[\s\S]|'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|\$\(\((?:[^()]|\([^()]*\))*\)\)/g,
    "''",
  );
}

function unwrapShell(command: string | null): string | null {
  let current = command;
  for (let depth = 0; current != null && depth < 3; depth += 1) {
    const match = SHELL_WRAPPER.exec(current);
    if (match == null) {
      return current;
    }
    const body = match[1] ?? "";
    if (/^['"]/.test(body)) {
      const script = quotedWord(body);
      // `bash -c 'a' _ b` or `bash -c "a"; rm b`: the stage check reads each wrapper.
      if (script == null) {
        return current;
      }
      current = script;
    } else {
      current = body;
    }
  }
  return current;
}

/** The contents of one single- or double-quoted word, or null when `word` is
 * anything more than that. */
function quotedWord(word: string): string | null {
  const single = /^'([^']*)'$/.exec(word);
  if (single != null) {
    return single[1] ?? "";
  }
  const double = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(word);
  return double == null ? null : (double[1] ?? "").replace(/\\(["\\$`])/g, "$1");
}

/** The words of the command a stage actually runs: without leading variable
 * assignments, subshell parens, control keywords (`do`, `then`, `if`), or
 * wrappers (`env`, `timeout 30`, `xargs -n1`, `time`). */
function commandWords(stage: string): string[] {
  let words = shellWords(stage);
  for (let guard = 0; guard < 16 && words.length > 0; guard += 1) {
    const first = words[0] ?? "";
    if (first.startsWith("(")) {
      const rest = first.replace(/^\(+/, "");
      words = rest === "" ? words.slice(1) : [rest, ...words.slice(1)];
    } else if (/^[A-Za-z_]\w*=\(/.test(first)) {
      // An array assignment, `dirs=(src tests)`, ends at the word closing it.
      const end = words.findIndex((word) => word.endsWith(")"));
      words = words.slice(end === -1 ? words.length : end + 1);
    } else if (/^[A-Za-z_]\w*=/.test(first) || COMMAND_PREFIXES.has(first)) {
      words = words.slice(1);
    } else if (first === "command") {
      const rest = words.slice(1);
      // `command -v bun` is `which bun`; `command bun test` runs bun.
      if (rest[0] === "-v" || rest[0] === "-V") {
        return ["which", ...rest.slice(1)];
      }
      words = rest;
    } else if ((first === "env" && words.length > 1) || COMMAND_WRAPPERS.has(first)) {
      words = skipOptions(words.slice(1), WRAPPER_VALUE_OPTIONS);
      if (first === "timeout") {
        words = words.slice(1);
      }
      if (first === "xargs" && words.length === 0) {
        return ["echo"];
      }
    } else {
      return words;
    }
  }
  return words;
}

/** Whitespace-split words, keeping quoted strings, escapes, and `$(...)` whole
 * and dropping redirections, which the statement-level check already judged. */
function shellWords(stage: string): string[] {
  const words = splitUnquoted(stage, WORD_BREAK).filter((word) => word !== "");
  const kept: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (/^\d*[<>]&\d*-?$/.test(word) || /^(?:\d*|&)(?:>>?|<<?-?|<<<)\S/.test(word)) {
      continue;
    }
    if (/^(?:\d*|&)(?:>>?|<<?-?|<<<)$/.test(word)) {
      i += 1;
      continue;
    }
    kept.push(word);
  }
  return kept;
}

function skipOptions(words: string[], valueOptions: Set<string>): string[] {
  let index = 0;
  while ((words[index] ?? "").startsWith("-")) {
    index += valueOptions.has(words[index] ?? "") ? 2 : 1;
  }
  return words.slice(index);
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function basename(value: string): string {
  const clean = value.replace(/^['"]|['"]$/g, "");
  return clean.split("/").filter(Boolean).at(-1) ?? clean;
}
