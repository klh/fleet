// hooks/gates/plane-loop.ts — W266.2 plane-loop gate (P0): the narrow
// PreToolUse(Bash) deny for commands that are outside-repo AND unbounded-loop
// AND spawn plane verbs (coord/fleet-loop/board) — the runaway-loop shape
// that hammers the coordination plane from a non-repo cwd. All three must
// hold; inside a repo the loop is allowed (tests, install scripts). The
// plane itself escapes via ~/.cache/claude-governor/plane-exempt.json (a sid
// array) — and the escape is LOGGED (denied-calls.jsonl, tool:"plane-exempt"),
// never silent.
//
// Scope: `while`/`until` heads with always-true/false conditions (true, :,
// /bin/true; until false). Arithmetic `for` is NOT covered — shell-quote
// drops the ((...)) header entirely (verified: `for ((;;))` and the bounded
// `for ((i=0;i<3;i++))` both tokenize to a bare ["for"] segment), so a rule
// there cannot separate bounded from unbounded without false positives.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditEscape, deny } from "../lib/hookio.ts";
import { run } from "../lib/run.ts";
import { commandStart } from "./bash-hardening.ts";

// ---- plane verbs: the coordination-plane CLIs a runaway loop would hammer
export const PLANE_VERBS = new Set(["coord", "fleet-loop", "board"]);

// shell keywords that precede the real command word inside a compound
// statement — `while true; do coord ping; done` arrives as segments
// ["while","true"], ["do","coord","ping"], ["done"]
const KEYWORD = new Set(["do", "then", "else"]);

// always-true/false loop conditions (the unbounded shapes)
const LOOP_TRUE = new Set(["true", ":", "/bin/true", "/usr/bin/true"]);
const LOOP_FALSE = new Set(["false", "/bin/false"]);

const exemptPath = () =>
	`${process.env.HOME ?? ""}/.cache/claude-governor/plane-exempt.json`;

/** The real command word of a segment, past loop/branch keywords (`do`,
 *  `then`, `else`) — commandStart stops AT them (they are not wrappers). */
export function segVerb(w: string[]): string {
	const i = commandStart(w);
	if (i === -1) return "";
	let j = i;
	while (j < w.length && KEYWORD.has(w[j])) j++;
	return w[j] ?? "";
}

/** True when a segment is an unbounded `while`/`until` head: the condition
 *  is made only of always-true/false primitives. */
export function unboundedLoopHead(w: string[]): boolean {
	const i = commandStart(w);
	if (i === -1) return false;
	const kw = w[i];
	const cond = w.slice(i + 1).filter((t) => !t.startsWith("<op"));
	if (kw === "while")
		return cond.length > 0 && cond.every((t) => LOOP_TRUE.has(t));
	if (kw === "until")
		return cond.length > 0 && cond.every((t) => LOOP_FALSE.has(t));
	return false;
}

/** True when dir is inside a git work tree. rev-parse prints "true" with
 *  exit 0 inside a work tree but also prints "false" with exit 0 in .git
 *  dirs and bare repos — the OUTPUT is the verdict, not the status. */
function insideRepo(dir: string): boolean {
	return (
		run("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: dir,
		}).out.trim() === "true"
	);
}

/** Plane-exempt sids (owner-maintained JSON array). Malformed file → the
 *  escape does not apply (fail-closed on the exemption, not the gate). */
function isExempt(sid: string): boolean {
	if (!sid) return false;
	try {
		const p = exemptPath();
		if (!existsSync(p)) return false;
		return (JSON.parse(readFileSync(p, "utf8")) as string[]).includes(sid);
	} catch {
		return false;
	}
}

/** The W266.2 gate section: called from bashGate with the pre-parsed
 *  segments. Cheap exit when no unbounded loop head is present; otherwise a
 *  plane-verb spawn whose effective cwd (cd-aware, like the secrets gate)
 *  sits outside any git work tree fires the conjunction. */
export function planeLoopGate(
	SEGS: string[][],
	CWD: string,
	sid: string,
): void {
	if (!SEGS.some(unboundedLoopHead)) return;
	let hit = ""; // first plane-verb spawn outside a repo
	let segCwd = CWD;
	for (const w of SEGS) {
		const i = commandStart(w);
		const v = i === -1 ? "" : (w[i] ?? "");
		if (v === "cd") {
			const tgt = w[w.length - 1];
			if (tgt && !tgt.startsWith("<op"))
				segCwd = tgt.startsWith("/") ? tgt : resolve(segCwd, tgt);
		}
		const pv = segVerb(w);
		if (!PLANE_VERBS.has(pv)) continue;
		if (insideRepo(segCwd)) continue;
		hit = pv;
		break;
	}
	if (!hit) return;
	const reason =
		`plane-loop-gate: unbounded loop spawning coordination-plane verbs (coord/fleet-loop/board) outside any git repo — runaway loops hammer the plane. ` +
		`Bound the loop or run inside a repo. If this session IS the plane itself, add its sid to ~/.cache/claude-governor/plane-exempt.json — the escape is logged.`;
	if (isExempt(sid)) {
		auditEscape(
			`plane-loop-gate: plane-exempt escape — sid ${sid} ran unbounded ${hit} outside a repo`,
		);
		return; // escaped, but the evidence landed in denied-calls.jsonl
	}
	deny(reason);
}
