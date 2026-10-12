// hooks/gates/destructive.ts — W250 two-person rule: the destructive-command
// detector. Pure and word-based over the gate words (bash-hardening.ts owns
// the parsing primitives — no lib/shellwords duplicate), so unit tests need
// no spawn. The CALLER decides enforcement policy (the bash gate applies it
// to fleet lanes only — owner sessions are exempt; the second person is a
// human co-signer via bin/approve-destructive.ts).
//
// The detector is deliberately conservative: high-signal, low-noise. A false
// positive costs one approval; a false negative is silent damage. Families
// overlapping the W513 hardening layer (git reset --hard, clean -f, checkout/
// restore discards) resolve HERE first so a co-signed command can pass —
// bash.ts forwards the approval to hardeningGate. Device redirects,
// sensitive-state writes, and containment stay absolute (never approvable).
import { parse } from "shell-quote";
import {
	backticksToSubshells,
	commandStart,
	isOp,
	segments,
	shCString,
	type Tok,
	words,
} from "./bash-hardening.ts";

// the hardened verb walk (bash-hardening owns command-start) under a local
// name so every detector family shares ONE definition.
const verbOf = (w: string[]): string => w[commandStart(w)] ?? "";

// short-flag cluster containing r/R → recursive (rm -rf, -Rf); long --recursive
function isRecursiveFlag(a: string): boolean {
	if (/^--[a-z-]+$/.test(a)) return a === "--recursive";
	if (/^-[a-zA-Z]+$/.test(a)) return a.includes("r") || a.includes("R");
	return false;
}

// short-flag cluster containing f → force (git push -f, git clean -fdx)
function hasForceFlag(a: string): boolean {
	return /^-[a-zA-Z]+$/.test(a) && a.includes("f");
}

// rm -r targets that are "everything": root, home, dot-paths, bare globs
const EVERYTHING = new Set([
	"/",
	"~",
	"~/*",
	"~/",
	"$HOME",
	"$HOME/*",
	"$HOME/",
	".",
	"./",
	"..",
	"../",
	"../*",
	"*",
	"./*",
]);

export function rmRecursiveHit(
	w: string[],
	segCwd: string,
	home: string,
): string | null {
	if (verbOf(w) !== "rm") return null;
	const args = w.slice(w.indexOf("rm") + 1);
	if (!args.some(isRecursiveFlag)) return null;
	for (const t of args) {
		if (t.startsWith("-")) continue;
		if (EVERYTHING.has(t)) return `rm -r ${t}`;
		if (resolvesInto(t, segCwd, home)) return `rm -r ${t}`;
	}
	return null;
}

// target resolves to "/" or the home dir, or contains/equals the segment cwd
// (an rm of the cwd or an ancestor eats the lane's own worktree — W64's
// "never rm a modified file in reaction" made structural).
function resolvesInto(t: string, segCwd: string, home: string): boolean {
	const p = expandHome(t);
	if (!p.startsWith("/")) return false; // globs/vars stay word-based
	const norm = p.replace(/\/+$/, "") || "/";
	if (norm === "/") return true;
	if (home && norm === home.replace(/\/+$/, "")) return true;
	if (!segCwd) return false;
	if (norm === segCwd) return true;
	return segCwd.startsWith(`${norm}/`); // ancestor of cwd
}

export function expandHome(t: string): string {
	let p = t;
	if (p === "~") return process.env.HOME ?? "";
	if (p.startsWith("~/")) p = `${process.env.HOME ?? ""}${p.slice(1)}`;
	if (p.startsWith("$HOME")) p = `${process.env.HOME ?? ""}${p.slice(5)}`;
	return p;
}

// ─── git destructive subcommands ─────────────────────────────────────────────

// destructive git subcommands: force-push, reset --hard, clean -f, and the
// discard forms (restore <pathspec>, checkout -- <pathspec>). --force-with-
// lease is the mitigated form — no hit. `git checkout <branch>` is a switch,
// not a discard — no hit. (branch -D stays W513-only: hard-denied, not
// approvable — a force-deleted lane branch is invisible to the ladder.)
export function gitDestructiveHit(w: string[]): string | null {
	const gi = w.indexOf("git");
	if (gi === -1) return null;
	let sub = "";
	for (let i = gi + 1; i < w.length; i++) {
		if (w[i].startsWith("-")) continue;
		sub = w[i];
		break;
	}
	const rest = w.slice(gi + 1);
	switch (sub) {
		case "push":
			if (rest.includes("--force") || rest.some(hasForceFlag))
				return "git push --force";
			return null; // --force-with-lease is the mitigated form — no hit
		case "reset":
			return rest.includes("--hard") ? "git reset --hard" : null;
		case "clean":
			return rest.some(hasForceFlag) ? "git clean -f" : null;
		case "restore":
			return rest.some((a) => !a.startsWith("-"))
				? "git restore <pathspec>"
				: null;
		case "checkout":
			return rest.includes("--") ? "git checkout -- <pathspec>" : null;
		default:
			return null;
	}
}

// ─── system, disk, SQL families ──────────────────────────────────────────────

const LAUNCHCTL_DESTRUCTIVE = new Set([
	"bootout",
	"remove",
	"disable",
	"unload",
]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const SQL_RE = /\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b/i;

export function systemHit(w: string[]): string | null {
	const v = verbOf(w);
	const rest = w.slice(w.indexOf(v) + 1);
	if (v === "launchctl" && LAUNCHCTL_DESTRUCTIVE.has(rest[0] ?? ""))
		return `launchctl ${rest[0]}`;
	if (["shutdown", "reboot", "halt"].includes(v)) return `${v} (power op)`;
	if (v.startsWith("mkfs")) return "mkfs (disk destroyer)";
	if (
		v === "diskutil" &&
		(rest.includes("eraseDisk") || rest.includes("eraseVolume"))
	)
		return "diskutil erase";
	if (v === "dd") {
		const of = rest.find((a) => a.startsWith("of=/dev/"));
		if (of) return `dd ${of}`;
	}
	return null;
}

export function sqlHit(w: string[]): string | null {
	return SQL_RE.test(w.join(" ")) ? "DROP/TRUNCATE (sql)" : null;
}

// pipe-to-shell: `curl/wget … | sh` — the classic blast-radius install. Scans
// the RAW token stream (a pipe SPLITS gate segments, so segment-level checks
// can't see it): curl/wget word → first `|` before another connector → shell
// verb. Wrappers between the pipe and the shell resolve through commandStart,
// so `curl x | sudo -u root sh` is seen past the option values.
export function pipeToShellHit(toks: Tok[]): string | null {
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (typeof t !== "string" || (t !== "curl" && t !== "wget")) continue;
		for (let j = i + 1; j < toks.length; j++) {
			if (isOp(toks[j], ";", "&", "&&", "||")) break;
			if (!isOp(toks[j], "|", "|&")) continue;
			const tail: string[] = [];
			for (let k = j + 1; k < toks.length; k++) {
				const tk = toks[k];
				if (typeof tk !== "string") break;
				tail.push(tk);
			}
			const ci = commandStart(tail);
			const target = ci >= 0 ? tail[ci] : "";
			if (SHELLS.has(target)) return `${t}|${target}`;
			break;
		}
	}
	return null;
}

// the scan the bash gate runs: raw top-level stream + nested `sh -c` payloads
// (gateSegments unwraps those for verb-keyed checks; a pipe inside the string
// needs the same unwrap here).
export function pipeToShellScan(cmd: string, depth = 0): string | null {
	if (depth > 8) return null;
	const toks = parse(backticksToSubshells(cmd)) as Tok[];
	const hit = pipeToShellHit(toks);
	if (hit) return hit;
	for (const w of segments(toks).map(words)) {
		const inner = shCString(w);
		if (!inner) continue;
		const nested = pipeToShellScan(inner, depth + 1);
		if (nested) return nested;
	}
	return null;
}

// umbrella: everything the two-person rule covers for ONE command segment
export function destructiveHit(
	w: string[],
	segCwd: string,
	home: string,
): string | null {
	return (
		rmRecursiveHit(w, segCwd, home) ??
		gitDestructiveHit(w) ??
		systemHit(w) ??
		sqlHit(w)
	);
}

// the two-person deny message — exported so tests pin the minter recipe
export function twoPersonReason(sid: string, hit: string): string {
	return `two-person: lane ${sid} issued \`${hit}\` — destructive ops by a lane need a human co-signer. From YOUR OWN terminal (not this lane): bun ~/.claude/hooks/bin/approve-destructive.ts -- <the exact command>; then retry the IDENTICAL command. Single-use, binds to the exact command text, 24h expiry, audited. (SUSPENDERS_TWO_PERSON=0 disables.)`;
}
