// hooks/gates/bash-hardening.ts — shell-syntax primitives for the pre-bash
// gate + the W513 hardening checks, lifted from oh-my-claudecode's deny-layer
// (github.com/Yeachan-Heo/oh-my-claudecode: scripts/git-guardrails.mjs
// quote-aware splitting + src/hooks/permission-handler isSafeRepoPath /
// isSensitiveRepoRelativePath containment). bash.ts orchestrates; this module
// owns the parsing and the deny rules. Scope decisions vs upstream:
//   - device redirects deny EVERY session (zero legit agent use)
//   - sensitive-state writes (.git/.ssh/.env): lanes deny, owner nudges
//   - realpath containment + destructive git: lanes only (owner stays free)
import { parse } from "shell-quote";
import { deny, nudge } from "../lib/hookio.ts";
import { resolveFleetLane, type FleetLane } from "../lib/fleetlane.ts";
import { basename, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";

// ---- token utilities (moved from bash.ts) ----
export type Op = { op: string };
export type Cmd = { cmd: string };
export type Tok = string | Op | Cmd;

export const isOp = (t: Tok, ...ops: string[]) =>
	typeof t === "object" && "op" in t && ops.includes((t as Op).op);

export function segments(toks: Tok[]): Tok[][] {
	const segs: Tok[][] = [[]];
	for (const t of toks) {
		if (isOp(t, ";", "&", "|", "&&", "||", "(", ")")) segs.push([]);
		else segs[segs.length - 1].push(t);
	}
	return segs.filter((s) => s.length > 0);
}

export const words = (seg: Tok[]): string[] =>
	seg.map((t) =>
		typeof t === "string" ? t : "op" in t ? `<op:${t.op}>` : "<sub>",
	);

// ---- hardened command-start walk (lifted: omc commandStart) ----
// Skips env assignments and wrapper commands, swallowing each wrapper's
// option VALUES — `sudo -u root git push` used to resolve to verb "-u"
// and dodge every verb-keyed gate section.
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUDO_VALUE_OPTS = new Set([
	"-u",
	"--user",
	"-g",
	"--group",
	"-h",
	"--host",
	"-p",
	"--prompt",
	"-C",
	"--close-from",
	"-T",
	"--command-timeout",
	"-R",
	"--chroot",
	"-D",
	"--chdir",
	"-r",
	"--role",
	"-t",
	"--type",
]);
const ENV_VALUE_OPTS = new Set([
	"-u",
	"--unset",
	"-C",
	"--chdir",
	"-S",
	"--split-string",
]);

/** Consume one wrapper's option run: plain flags pass, listed opts swallow
 *  their value word, `--` ends the run. Returns the next index. */
function skipFlags(w: string[], i: number, valueOpts: Set<string>): number {
	while (i < w.length && w[i].startsWith("-")) {
		if (w[i] === "--") return i + 1;
		if (valueOpts.has(w[i])) i++;
		i++;
	}
	return i;
}

/** Index of the real command word, or -1. */
export function commandStart(w: string[]): number {
	let i = 0;
	while (i < w.length && ASSIGN_RE.test(w[i])) i++;
	for (;;) {
		if (i >= w.length) return -1;
		const t = w[i];
		if (t === "sudo") {
			i = skipFlags(w, i + 1, SUDO_VALUE_OPTS);
		} else if (t === "env") {
			i = skipFlags(w, i + 1, ENV_VALUE_OPTS);
			while (i < w.length && ASSIGN_RE.test(w[i])) i++;
		} else if (t === "exec") {
			i++;
			if (w[i] === "-a") i += 2;
			else if (w[i] === "--") i++;
		} else if (t === "command") {
			i++;
			if (w[i] === "-p") i++;
		} else if (t === "nohup") {
			i++;
			if (w[i] === "--") i++;
		} else if (t === "nice") {
			i++;
			if (w[i] === "-n") i += 2;
		} else if (t === "time") {
			i++;
			while (w[i] === "-p" || w[i] === "-v") i++;
			if (w[i] === "-f" || w[i] === "--format") i += 2;
		} else if (ASSIGN_RE.test(t)) {
			i++;
		} else {
			return i;
		}
	}
}

export function verb(w: string[]): string {
	return w[commandStart(w)] ?? "";
}

// the git SUBCOMMAND is the first non-flag token after "git" (global option
// values skipped — see GIT_GLOBAL_VALUE_OPTS). "push"/"commit" as any OTHER
// token must not trigger the scans: `git stash push` is a local op — the
// any-token check denied it in any repo with history secrets (it is not a
// remote write; W40 incident 2026-09-26).
const GIT_GLOBAL_VALUE_OPTS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
]);

export function gitSubIndex(w: string[]): { sub: string; idx: number } {
	const gi = w.indexOf("git");
	if (gi === -1) return { sub: "", idx: -1 };
	for (let i = gi + 1; i < w.length; i++) {
		const t = w[i];
		if (GIT_GLOBAL_VALUE_OPTS.has(t)) {
			i++; // space-form global option: its value is never the subcommand
			continue;
		}
		if (t.startsWith("-")) continue;
		return { sub: t, idx: i };
	}
	return { sub: "", idx: -1 };
}

export function gitSub(w: string[]): string {
	return gitSubIndex(w).sub;
}

// ---- nested segments (lifted: omc shellCommands recursion) ----
// shell-quote flattens $(...) into op-delimited inner tokens (already
// segmented) but mangles backticks into literal words ("`git") and leaves
// `sh -c '...'` payloads opaque — both dodge every verb-keyed section.
const SH_FAMILY = new Set(["sh", "bash", "dash", "ash", "ksh", "zsh"]);
const GATE_DEPTH_CAP = 8;

/** Rewrite `cmd` to $(cmd) quote-awarely (single-quoted backticks are
 *  literal; escaped backticks do not open a substitution). */
export function backticksToSubshells(cmd: string): string {
	let out = "";
	let q: string | null = null;
	const scan = (from: number): number => {
		let q2: string | null = null;
		for (let j = from; j < cmd.length; j++) {
			const c = cmd[j];
			if (q2 === "'") {
				if (c === "'") q2 = null;
			} else if (q2 === '"') {
				if (c === "\\") j++;
				else if (c === '"') q2 = null;
			} else if (c === "\\") {
				j++;
			} else if (c === "'" || c === '"') {
				q2 = c;
			} else if (c === "`") {
				return j;
			}
		}
		return -1;
	};
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (q === "'") {
			if (c === "'") q = null;
		} else if (q === '"') {
			if (c === "\\") {
				out += c + (cmd[i + 1] ?? "");
				i++;
				continue;
			}
			if (c === '"') q = null;
		} else if (c === "\\") {
			out += c + (cmd[i + 1] ?? "");
			i++;
			continue;
		} else if (c === "'" || c === '"') {
			q = c;
		} else if (c === "`") {
			const close = scan(i + 1);
			if (close !== -1) {
				out += `$(${cmd.slice(i + 1, close)})`;
				i = close;
				continue;
			}
		}
		out += c;
	}
	return out;
}

/** The string a segment's `sh -c <string>` carries, "" when none. */
export function shCString(w: string[]): string {
	const ci = commandStart(w);
	if (ci === -1 || !SH_FAMILY.has(w[ci])) return "";
	for (let i = ci + 1; i < w.length; i++) {
		const t = w[i];
		if (t === "--") continue;
		if (t === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return w[i + 1] ?? "";
		if (!t.startsWith("-")) return "";
	}
	return "";
}

/** The gate's canonical segment view: quote-aware split + backtick rewrite
 *  + sh -c unwrapping, recursive (inner commands become scannable segments). */
export function gateSegments(CMD: string): string[][] {
	const out: string[][] = [];
	const walk = (s: string, depth: number) => {
		if (depth > GATE_DEPTH_CAP) return;
		for (const seg of segments(parse(backticksToSubshells(s)) as Tok[])) {
			const w = words(seg);
			out.push(w);
			const inner = shCString(w);
			if (inner) walk(inner, depth + 1);
		}
	};
	walk(CMD, 0);
	return out;
}

// ---- canonical path (moved from bash.ts; join fixed — the dirname+"/"+
// basename fallback produced "//x" for root-adjacent paths, which breaks
// containment prefix matching) ----
export const canonPath = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		try {
			return resolve(realpathSync(dirname(p)), basename(p));
		} catch {
			return resolve(p);
		}
	}
};

export const throwaway = (p: string) =>
	p.startsWith("/tmp/") ||
	p.startsWith("/private/tmp/") ||
	p.startsWith("/dev/") ||
	p.includes("$TMPDIR");

// ---- write-target collection (moved from the bash.ts lease section) ----
// Every path a shell segment WRITES through a path target: redirects,
// tee/touch/truncate/sd/ambr args, cp/mv/rsync/ditto destinations, rm args,
// dd of=. Resolved against the segment's cwd; `cd X` takes effect for LATER
// segments (a redirect on the cd line itself resolves in the pre-cd cwd).
export function collectWriteTargets(SEGS: string[][], CWD: string): string[] {
	const targets: string[] = [];
	let segCwd = CWD;
	for (const w of SEGS) {
		const v = verb(w);
		const vi = w.indexOf(v);
		const rest = vi >= 0 ? w.slice(vi + 1) : w;
		for (let i = 0; i < w.length; i++) {
			if (w[i].startsWith("<op:>") && w[i + 1]) {
				// 2>&1-style fd dups are not path writes
				const next = String(w[i + 1]);
				if (!(w[i] === "<op:>&" && /^\d+$/.test(next)))
					targets.push(resolve(segCwd, next));
			}
		}
		if (["tee", "touch", "truncate", "sd", "ambr"].includes(v)) {
			for (const t of rest)
				if (!t.startsWith("-")) targets.push(resolve(segCwd, t));
		}
		if (["cp", "mv", "rsync", "ditto"].includes(v)) {
			const last = rest[rest.length - 1];
			if (last && !last.startsWith("-")) targets.push(resolve(segCwd, last));
		}
		if (v === "rm")
			for (const t of rest)
				if (!t.startsWith("-")) targets.push(resolve(segCwd, t));
		if (v === "dd")
			for (const kv of rest)
				if (kv.startsWith("of=")) targets.push(resolve(segCwd, kv.slice(3)));
		if (v === "cd") {
			const target = w[w.length - 1];
			if (target && !target.startsWith("<op"))
				segCwd = target.startsWith("/") ? target : resolve(segCwd, target);
		}
	}
	return targets;
}

// ---- W513 hardening checks ----

// Device redirects: catastrophic by definition in an agent session
// (`> /dev/sda` trashes a disk; the old throwaway() carve-out exempted /dev).
const DEV_OK = [
	/^\/dev\/null$/,
	/^\/dev\/std(out|in|err)$/,
	/^\/dev\/tty[^/]*$/,
	/^\/dev\/fd\//,
];

export function deviceDenyReason(t: string): string {
	if (!t.startsWith("/dev/")) return "";
	for (const re of DEV_OK) if (re.test(t)) return "";
	return `bash-hardening: device redirect to ${t} denied — a shell write to a device node is catastrophic and never needed. Use /dev/null.`;
}

// Sensitive-state writes (lifted: omc isSensitiveRepoRelativePath): shell
// rewrites of git internals, ssh state, or THE env file are the smuggling
// vector the secrets gate cannot see (gitleaks scans commit content, not
// `> .git/hooks/pre-commit`). Template files (.env.example) stay writable.
export function sensitiveDenyReason(t: string): string {
	const parts = t.split("/");
	if (
		parts.includes(".git") ||
		parts.includes(".ssh") ||
		basename(t) === ".env"
	)
		return `bash-hardening: shell write to ${t} denied — .git/.ssh/.env state must move through the governed Edit/Write tools (diffed, leased, reviewable).`;
	return "";
}

// Realpath containment (lifted: omc isSafeRepoPath): a lane's shell writes
// stay inside its worktree or /tmp — a symlink that canonicalizes outside
// the boundary is the escape this catches (canonPath resolves it).
export function containmentDenyReason(t: string, worktree: string): string {
	if (throwaway(t)) return "";
	const root = canonPath(worktree);
	const P = canonPath(t);
	if (P === root || P.startsWith(`${root}/`)) return "";
	return `bash-hardening: lane write to ${t} resolves outside this lane's worktree (${worktree}). Keep writes in the worktree; stage anything else under /tmp.`;
}

// Destructive git (lifted: omc git-guardrails destructiveLabel, minus push —
// our push-guard already owns main, and lane branch pushes are the flow).
function shortHas(
	options: string[],
	flag: string,
	valueOpts: string[],
): boolean {
	return options.some((o) => {
		if (!/^-[^-]+$/.test(o)) return false;
		for (const f of o.slice(1)) {
			if (f === flag) return true;
			if (valueOpts.includes(f)) break;
		}
		return false;
	});
}

function optionsBefore(args: string[], valueOpts: string[]): string[] {
	const values = new Set(valueOpts);
	const options: string[] = [];
	for (let i = 0; i < args.length && args[i] !== "--"; i++) {
		options.push(args[i]);
		if (values.has(args[i])) i++;
	}
	return options;
}

export function destructiveGitLabel(w: string[]): string {
	if (gitSub(w) === "") return "";
	const { idx } = gitSubIndex(w);
	const sub = w[idx];
	const args = w.slice(idx + 1);
	if (sub === "reset") return args.includes("--hard") ? "git reset --hard" : "";
	if (sub === "clean") {
		const opts = optionsBefore(args, ["e", "--exclude"]);
		const dry = opts.includes("--dry-run") || shortHas(opts, "n", ["e"]);
		const force = opts.includes("--force") || shortHas(opts, "f", ["e"]);
		return force && !dry ? "git clean -f" : "";
	}
	if (sub === "branch") {
		const opts = optionsBefore(args, ["--format", "--sort"]);
		const deletes =
			opts.includes("--delete") ||
			shortHas(opts, "d", []) ||
			shortHas(opts, "D", []);
		const forced =
			opts.includes("--force") ||
			shortHas(opts, "f", []) ||
			shortHas(opts, "D", []);
		return deletes && forced ? "git branch -D" : "";
	}
	if (sub === "checkout" || sub === "restore") {
		const sep = args.indexOf("--");
		const valueOpts =
			sub === "checkout"
				? [
						"-b",
						"-B",
						"--branch",
						"--orphan",
						"--conflict",
						"--pathspec-from-file",
					]
				: ["-s", "--source", "--conflict", "--pathspec-from-file"];
		const values = new Set(valueOpts);
		const pathspecs =
			sep === -1
				? args.filter((a, i) => !a.startsWith("-") && !values.has(args[i - 1]))
				: args.slice(sep + 1);
		return pathspecs.includes(".") ? `git ${sub} . (working-tree discard)` : "";
	}
	return "";
}

// ---- gate entry: the four checks over the collected targets ----
export function hardeningGate(SEGS: string[][], CWD: string): void {
	const targets = collectWriteTargets(SEGS, CWD);
	let lane: FleetLane | null | undefined; // resolved lazily, once, on first need

	const forLanes = (fn: (l: FleetLane) => void) => {
		if (lane === undefined) lane = resolveFleetLane(CWD);
		if (lane) fn(lane);
	};

	for (const t of targets) {
		const dev = deviceDenyReason(t);
		if (dev) deny(dev);
		const sens = sensitiveDenyReason(t);
		if (sens) forLanes(() => deny(sens));
		if (!sens)
			forLanes((l) => {
				const c = containmentDenyReason(t, l.worktree);
				if (c) deny(c);
			});
	}
	for (const w of SEGS) {
		if (verb(w) !== "git") continue;
		const label = destructiveGitLabel(w);
		if (label)
			forLanes(() =>
				deny(
					`bash-hardening: ${label} denied for fleet lanes — it destroys work the merge ladder and other lanes can see. Selective paths (git checkout -- <file>), the coordinator, or the owner must own the discard.`,
				),
			);
	}
	// Owner sessions: sensitive-state writes get a nudge, never a block.
	for (const t of targets) {
		if (sensitiveDenyReason(t) && lane === null) nudge(sensitiveDenyReason(t));
	}
}
