/** Read-only verdicts for shell stages and per-command read-only tables (git,
 * gh, kubectl, docker, curl, find, awk, sed, sqlite3, npm, aws, xcrun), plus the
 * script walker that decides code-vs-context for a whole shell script.
 * W1238.6.3: moved verbatim from the vendored buckets.ts. */

import type { ActivityBucket } from "./buckets.ts";
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
  stripQuoted,
  substitutions,
  unquote,
} from "./shell-text.ts";

export { GIT_VALUE_OPTIONS, scriptBucket, stageVerdict };

const READONLY_BASH = new Set([
  "ls",
  "cat",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "ack",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "printf",
  "stat",
  "file",
  "which",
  "type",
  "env",
  "printenv",
  "diff",
  "cmp",
  "comm",
  "paste",
  "tac",
  "rev",
  "nl",
  "cut",
  "tr",
  "jq",
  "du",
  "df",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "less",
  "more",
  "column",
  "od",
  "hexdump",
  "strings",
  "shasum",
  "sha256sum",
  "md5",
  "md5sum",
  "cksum",
  "test",
  "[",
  "[[",
  "date",
  "ps",
  "pgrep",
  "lsof",
  "uname",
  "whoami",
  "id",
  "sw_vers",
  "uptime",
  "jobs",
  "bc",
  "expr",
  "seq",
]);
const READONLY_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "rev-parse",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "merge-base",
  "cat-file",
  "name-rev",
  "check-ignore",
  "verify-commit",
  "grep",
  "describe",
  "shortlog",
  "version",
]);
// Commands that only change the shell's own state. A statement made of these
// neither reads nor writes the repo, so it never decides a compound command.
// `sleep` and `wait` are not here: an agent sleeps to wait on a build, a test
// run, or CI, and that time belongs to the work it waits on.
const NAVIGATION = new Set([
  "cd",
  "pushd",
  "popd",
  "true",
  "false",
  ":",
  "export",
  "unset",
  "set",
  "shopt",
  "local",
  "declare",
  "readonly",
  "for",
  "done",
  "fi",
  "}",
]);
// A bare `version` word is not here: `yarn version` and `changeset version` bump versions.
const VERSION_ARGS = new Set(["--version", "-v", "-V", "--help", "-h", "help"]);
// An output redirect (`>`, `>>`, `>|`, `2>`, `&>`, `>&`, `<>`) writes a file
// unless it targets a descriptor or a device like /dev/null.
const WRITE_REDIRECT =
  /(?:&>>?|\d*(?:>>|>\||<>|>))(?!&\d|&-|\s*\/dev\/(?:null|stdout|stderr|tty)\b)/;
let nesting = 0;

function scriptBucket(script: string): ActivityBucket {
  if (nesting >= MAX_NESTING) {
    return "code";
  }
  nesting += 1;
  try {
    return statementsBucket(script);
  } finally {
    nesting -= 1;
  }
}

function statementsBucket(script: string): ActivityBucket {
  for (const statement of splitUnquoted(script, STATEMENT_BREAK)) {
    if (statement.trim() === "") {
      continue;
    }
    if (WRITE_REDIRECT.test(stripQuoted(statement))) {
      return "code";
    }
    // `$(...)` runs too: `X=$(git merge-base a b)` reads, `X=$(rm f)` does not.
    if (substitutions(statement).some((body) => scriptBucket(body) === "code")) {
      return "code";
    }
    if (splitUnquoted(statement, PIPE).some((stage) => stageVerdict(stage) === "code")) {
      return "code";
    }
  }
  return "context";
}

// A lone `&` backgrounds a job and starts the next statement; `&>`, `>&`, and
// `|&` are redirects or pipes, which the preceding character rules out. The
// separators are sticky so splitting matches in place instead of re-slicing the
/** `sh -c '<script>' [name args...]` runs the script; any other shell call runs a file or stdin. */
function shellVerdict(args: string[]): ActivityBucket {
  const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  const script = flag === -1 ? undefined : args[flag + 1];
  if (script == null) {
    return "code";
  }
  return scriptBucket(stripHeredocBodies(quotedWord(script) ?? script));
}

function stageVerdict(stage: string): ActivityBucket | "neutral" {
  const words = commandWords(stage);
  if (words.length === 0) {
    return "neutral";
  }
  const head = basename(words[0] ?? "");
  const args = words.slice(1);
  if (NAVIGATION.has(head) || head === ")") {
    return "neutral";
  }
  if (READONLY_BASH.has(head)) {
    return "context";
  }
  if (SHELLS.has(head) && args.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg))) {
    return shellVerdict(args);
  }
  if ((args.length === 1 && VERSION_ARGS.has(args[0] ?? "")) || args.includes("--help")) {
    return "context";
  }
  return READONLY_WHEN[head]?.(args) ? "context" : "code";
}
// Commands that are read-only only with some arguments.
const READONLY_WHEN: Record<string, (args: string[]) => boolean> = {
  git: gitReadOnly,
  gh: ghReadOnly,
  kubectl: kubectlReadOnly,
  docker: dockerReadOnly,
  "docker-compose": composeReadOnly,
  curl: curlReadOnly,
  find: findReadOnly,
  // `fd -x cmd` runs cmd per match, like `find -exec`.
  fd: (args) => {
    const exec = args.findIndex((arg) => /^(?:-x|-X|--exec|--exec-batch)$/.test(arg));
    return exec === -1 || stageVerdict(args.slice(exec + 1).join(" ")) === "context";
  },
  // `rg --pre cmd` runs cmd on every file it searches.
  rg: (args) => !args.some((arg) => /^--pre(?:=|$)/.test(arg)),
  tree: (args) => !args.some((arg) => arg.startsWith("-o")),
  // `uniq in out` writes out.
  uniq: (args) => positionals(args, new Set(["-f", "-s", "-w"])).length <= 1,
  awk: awkReadOnly,
  gawk: awkReadOnly,
  sed: sedReadOnly,
  sort: (args) => !args.some((arg) => /^-[a-zA-Z]*o/.test(arg) || arg.startsWith("--output")),
  base64: (args) => !args.some((arg) => arg === "-o" || arg.startsWith("--output")),
  sqlite3: sqliteReadOnly,
  npm: (args) =>
    ["view", "info", "show", "ls", "list", "outdated", "why", "explain"].includes(args[0] ?? ""),
  "ssh-add": (args) => args.length > 0 && args.every((arg) => arg === "-l" || arg === "-L"),
  // macOS unified log: `log show` and `log stream` only read.
  log: (args) => args[0] === "show" || args[0] === "stream",
  sysctl: (args) => !args.some((arg) => arg === "-w" || /^[\w.]+=/.test(arg)),
  aws: (args) => {
    const [, operation = ""] = skipOptions(args, AWS_VALUE_OPTIONS);
    return (
      (/^(?:get|describe|list|head)-/.test(operation) && !AWS_DOWNLOADS.has(operation)) ||
      operation === "ls"
    );
  },
  xcrun: (args) =>
    args.some(
      (arg) => arg === "--show-sdk-path" || arg === "--show-sdk-version" || arg === "--find",
    ) ||
    (args[0] === "simctl" && args[1] === "list"),
};

const AWS_VALUE_OPTIONS = new Set(["--region", "--profile", "--output", "--endpoint-url"]);
// Reads that save the response to an outfile argument.
const AWS_DOWNLOADS = new Set(["get-object", "get-object-torrent", "get-media", "get-job-output"]);

/** The non-option words of `args`, skipping the value of each option in `valueOptions`. */
function positionals(args: string[], valueOptions: Set<string>): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (valueOptions.has(arg)) {
      i += 1;
    } else if (!arg.startsWith("-")) {
      words.push(arg);
    }
  }
  return words;
}

/** True when `args` use one of `flags`, including `--flag=value` and short-flag
 * clusters such as `-rd` or `-uorigin/main`. */
function usesFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) =>
    arg.startsWith("--")
      ? flags.has(arg.split("=")[0] ?? arg)
      : /^-[a-zA-Z]/.test(arg) && [...arg.slice(1)].some((char) => flags.has(`-${char}`)),
  );
}

// `w file`, `e cmd`, and the `w`/`e` flags of `s`, each in command position:
// at the start, after `;`, `{`, `}`, a newline, or an address (`12`, `$`, `/re/`, `!`).
const SED_SCRIPT_WRITES =
  /(?:^|[;{}\n\d$/!])\s*(?:[wWe](?:\s|$)|s([^\w\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImM\d]*[we])/;

/** sed reads unless it edits in place, runs a script file it does not show, or
 * its script writes a file (`w`, `s///w`) or runs a command (`e`, `s///e`). */
function sedReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  let explicit = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (/^-[a-zA-Z]*i/.test(arg) || /^--(?:in-place|file)/.test(arg) || /^-[a-zA-Z]*f$/.test(arg)) {
      return false;
    }
    if (/^-[a-zA-Z]*e$/.test(arg) || arg === "--expression") {
      scripts.push(args[i + 1] ?? "");
      explicit = true;
      i += 1;
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      explicit = true;
    } else if (!arg.startsWith("-") && !explicit && scripts.length === 0) {
      scripts.push(arg);
    }
  }
  return !scripts.some((script) => SED_SCRIPT_WRITES.test(unquote(script)));
}

const SQLITE_VALUE_OPTIONS = new Set(["-separator", "-newline", "-nullvalue", "-vfs", "-mmap"]);
// Dot-commands that write or run something, and `VACUUM INTO`, which writes a
// copy even from a read-only connection.
const SQLITE_WRITES =
  /(?:^|[\s;])\.(?:output|once|save|backup|clone|open|shell|system|import|log|trace|excel)\b|\bvacuum\s+into\b/i;

/** `sqlite3 -readonly db 'sql'` reads. SQL from stdin, `-init`, or a heredoc is
 * not visible here, so it counts as code. */
function sqliteReadOnly(args: string[]): boolean {
  const sql: string[] = [];
  let positional = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] ?? "").replace(/^--/, "-");
    if (arg === "-init") {
      return false;
    }
    if (arg === "-cmd" || SQLITE_VALUE_OPTIONS.has(arg)) {
      if (arg === "-cmd") {
        sql.push(args[i + 1] ?? "");
      }
      i += 1;
    } else if (!arg.startsWith("-")) {
      positional += 1;
      if (positional > 1) {
        sql.push(arg);
      }
    }
  }
  return (
    args.some((arg) => arg.replace(/^--/, "-") === "-readonly") &&
    positional > 1 &&
    !sql.some((text) => SQLITE_WRITES.test(unquote(text)))
  );
}

// Global options whose value is the next word (`git -C dir log`).
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_BRANCH_WRITES = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-f",
  "-u",
  "-t",
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--track",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
]);
const GIT_CONFIG_WRITES = new Set([
  "--unset",
  "--unset-all",
  "--add",
  "--replace-all",
  "--remove-section",
  "--rename-section",
  "-e",
  "--edit",
]);
const GIT_TAG_WRITES = new Set([
  "-a",
  "-s",
  "-u",
  "-f",
  "-d",
  "-m",
  "-F",
  "-e",
  "--annotate",
  "--sign",
  "--local-user",
  "--delete",
  "--force",
  "--message",
  "--file",
  "--edit",
]);
// Listing flags that take a commit or pattern, so a positional word is not a new ref name.
const GIT_LIST_FLAGS = new Set([
  "-l",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);

function gitReadOnly(args: string[]): boolean {
  const words = skipOptions(args, GIT_VALUE_OPTIONS);
  const subcommand = words[0];
  const rest = words.slice(1);
  if (subcommand == null) {
    return args.some((arg) => VERSION_ARGS.has(arg));
  }
  if (rest.some((arg) => arg.startsWith("--output"))) {
    return false;
  }
  const listsRefs =
    rest.every((arg) => arg.startsWith("-")) || rest.some((arg) => GIT_LIST_FLAGS.has(arg));
  switch (subcommand) {
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "config": {
      const [first, ...keys] = rest.filter((arg) => !arg.startsWith("-"));
      // Keys have a dot, so a bare first word is a subcommand (`git config get x`).
      if (first != null && !first.includes(".")) {
        return first === "list" || (first === "get" && !usesFlag(rest, GIT_CONFIG_WRITES));
      }
      // `git config key` reads one value; a second positional word sets it.
      return (
        rest.some((arg) => arg === "--list" || arg === "-l" || arg.startsWith("--get")) ||
        (first != null && keys.length === 0 && !usesFlag(rest, GIT_CONFIG_WRITES))
      );
    }
    case "branch":
      return listsRefs && !usesFlag(rest, GIT_BRANCH_WRITES);
    case "tag":
      return listsRefs && !usesFlag(rest, GIT_TAG_WRITES);
    case "remote":
      return rest.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(rest[0] ?? "");
    case "worktree":
      return rest[0] === "list";
    default:
      return READONLY_GIT.has(subcommand);
  }
}

const GH_READONLY: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list"]),
  workflow: new Set(["view", "list"]),
  repo: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  auth: new Set(["status", "token"]),
  search: new Set(["code", "commits", "issues", "prs", "repos"]),
};
const GH_FIELD_OPTIONS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

function ghReadOnly(args: string[]): boolean {
  const [group, verb] = args;
  if (group === "api") {
    return ghApiReadOnly(args.slice(1));
  }
  // `gh pr checks --watch` waits on CI, like `gh run watch`.
  return (
    group != null &&
    verb != null &&
    (GH_READONLY[group]?.has(verb) ?? false) &&
    !args.includes("--watch")
  );
}

/** `gh api` sends GET unless a method says otherwise or a body field turns the
 * request into a POST; a GraphQL call writes only when it is a mutation. */
function ghApiReadOnly(args: string[]): boolean {
  let method: string | null = null;
  let fields = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-X" || arg === "--method") {
      method = unquote(args[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("-X") || arg.startsWith("--method=")) {
      method = unquote(arg.replace(/^-X|^--method=/, ""));
    } else if (GH_FIELD_OPTIONS.has(arg) || /^--(?:raw-)?field=|^-[fF]./.test(arg)) {
      fields = true;
    }
  }
  if (method != null) {
    return /^(?:GET|HEAD)$/i.test(method);
  }
  if (args[0] === "graphql") {
    return !/\bmutation\b/.test(args.join(" "));
  }
  return !fields;
}

const KUBECTL_VALUE_OPTIONS = new Set([
  "--context",
  "-n",
  "--namespace",
  "--kubeconfig",
  "--cluster",
  "--user",
  "-s",
  "--server",
]);
const KUBECTL_READONLY = new Set([
  "get",
  "describe",
  "logs",
  "top",
  "explain",
  "api-resources",
  "api-versions",
  "version",
  "cluster-info",
  "events",
]);
const KUBECTL_READONLY_PAIRS: Record<string, Set<string>> = {
  config: new Set(["view", "get-contexts", "current-context", "get-clusters"]),
  auth: new Set(["can-i", "whoami"]),
  rollout: new Set(["status", "history"]),
};

function kubectlReadOnly(args: string[]): boolean {
  const [verb, object] = skipOptions(args, KUBECTL_VALUE_OPTIONS);
  if (verb == null) {
    return false;
  }
  if (verb === "cluster-info" && args.some((arg) => arg.startsWith("--output-directory"))) {
    return false;
  }
  return KUBECTL_READONLY.has(verb) || (KUBECTL_READONLY_PAIRS[verb]?.has(object ?? "") ?? false);
}

const DOCKER_READONLY = new Set([
  "ps",
  "images",
  "logs",
  "inspect",
  "version",
  "info",
  "top",
  "port",
  "history",
]);
const DOCKER_OBJECTS = new Set(["image", "container", "network", "volume", "context", "system"]);
const DOCKER_OBJECT_READONLY = new Set(["ls", "inspect", "logs", "history", "top", "port", "df"]);
const DOCKER_COMPOSE_VALUE_OPTIONS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "--project-directory",
]);
const DOCKER_COMPOSE_READONLY = new Set(["ps", "logs", "config", "images", "ls", "top", "port"]);

function composeReadOnly(args: string[]): boolean {
  const [command, ...rest] = skipOptions(args, DOCKER_COMPOSE_VALUE_OPTIONS);
  // `compose config -o file` writes the resolved file.
  if (command === "config" && rest.some((arg) => arg === "-o" || arg.startsWith("--output"))) {
    return false;
  }
  return DOCKER_COMPOSE_READONLY.has(command ?? "");
}

const DOCKER_VALUE_OPTIONS = new Set([
  "--context",
  "-c",
  "-H",
  "--host",
  "--config",
  "-l",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);

function dockerReadOnly(args: string[]): boolean {
  const [verb, object] = skipOptions(args, DOCKER_VALUE_OPTIONS);
  if (verb === "compose") {
    return composeReadOnly(args.slice(args.indexOf("compose") + 1));
  }
  return (
    DOCKER_READONLY.has(verb ?? "") ||
    (DOCKER_OBJECTS.has(verb ?? "") && DOCKER_OBJECT_READONLY.has(object ?? ""))
  );
}

// Short curl flags that send a body or write a file; `-o` and `-X` are judged
// by their value, and the rest of the value-taking flags just consume one.
// A config file (`-K`) can hold any of these, and `-Q` sends raw FTP/SFTP commands.
const CURL_WRITE_FLAGS = new Set(["d", "F", "T", "D", "c", "O", "K", "Q"]);
const CURL_VALUE_FLAGS = new Set([
  "o",
  "X",
  "H",
  "A",
  "u",
  "w",
  "m",
  "e",
  "E",
  "x",
  "b",
  "r",
  "C",
  "U",
  "Y",
  "y",
  "z",
]);
const CURL_WRITE_OPTIONS =
  /^--(?:data|form|json|upload-file|remote-name|dump-header|cookie-jar|output-dir|trace|config|quote|libcurl|stderr|etag-save|hsts|alt-svc)/;
const LOCAL_HOST = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\]/;

/** A remote GET that prints its response is web retrieval. Probing a local
 * dev server verifies the work, so it stays code, like running its tests. */
function curlReadOnly(args: string[]): boolean {
  // `-w '%output{file}'` switches the write-out to a file.
  if (args.some((arg) => LOCAL_HOST.test(arg) || arg.includes("%output{"))) {
    return false;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--output" || arg === "--request") {
      if (!readOnlyCurlValue(arg === "--output" ? "o" : "X", args[i + 1])) {
        return false;
      }
      i += 1;
    } else if (arg.startsWith("--output=") || arg.startsWith("--request=")) {
      const flag = arg.startsWith("--output") ? "o" : "X";
      if (!readOnlyCurlValue(flag, arg.slice(arg.indexOf("=") + 1))) {
        return false;
      }
    } else if (CURL_WRITE_OPTIONS.test(arg)) {
      return false;
    } else if (/^-[A-Za-z]/.test(arg)) {
      for (let j = 1; j < arg.length; j += 1) {
        const flag = arg[j] ?? "";
        if (CURL_WRITE_FLAGS.has(flag)) {
          return false;
        }
        if (CURL_VALUE_FLAGS.has(flag)) {
          const inline = arg.slice(j + 1);
          const value = inline === "" ? args[i + 1] : inline;
          if (inline === "") {
            i += 1;
          }
          if ((flag === "o" || flag === "X") && !readOnlyCurlValue(flag, value)) {
            return false;
          }
          break;
        }
      }
    }
  }
  return true;
}

function readOnlyCurlValue(flag: string, value: string | undefined): boolean {
  const clean = unquote(value ?? "");
  return flag === "o" ? clean === "/dev/null" || clean === "-" : /^(?:GET|HEAD)$/i.test(clean);
}

const FIND_WRITES = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** `find` reads unless it deletes, writes a listing, or `-exec`s a command
 * that is not itself read-only (`-exec cat {} \;` reads, `-exec rm` does not). */
function findReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (FIND_WRITES.has(arg)) {
      return false;
    }
    if (FIND_EXEC.has(arg)) {
      const rest = args.slice(i + 1);
      const end = rest.findIndex((word) => /^(?:\\;|';'|";"|;|\+)$/.test(word));
      const command = (end === -1 ? rest : rest.slice(0, end)).join(" ");
      if (stageVerdict(command) !== "context") {
        return false;
      }
      i += end === -1 ? rest.length : end + 1;
    }
  }
  return true;
}

/** awk reads unless its program shells out or prints into a file or command.
 * A lone `|` after print pipes to a command; `||` is only a logical or. */
function awkReadOnly(args: string[]): boolean {
  // Judge the program without its string literals, so `printf "a | b"` stays a read.
  const program = args
    .map((arg) => quotedWord(arg) ?? arg)
    .join(" ")
    .replace(/"(?:[^"\\]|\\[\s\S])*"?/g, '""');
  return !/\bsystem\s*\(|\|&?\s*getline\b|\bprintf?\b[^;}]*(?:>|(?<!\|)\|(?!\|))|\binplace\b/.test(
    program,
  );
}
