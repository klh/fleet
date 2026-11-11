#!/usr/bin/env bun
// hooks/bin/gate-wire-codex.ts — merge-not-clobber codex hook wiring (W73,
// generation-stable since W2961). Merges the five suspenders gate
// registrations into ~/.codex/hooks.json (or $SUSPENDERS_CODEX_HOOKS),
// preserving every entry that is not ours. Managed entries are recognized
// by their command SHAPE (anchored gate-path argument), never a substring;
// user entries are never touched.
// W2961: the managed command rides the STABLE install symlink
// (~/.claude/hooks/suspenders), never a pinned generation dir — every
// install re-pinning its own import.meta.dir staled the previous binding,
// so a later generation whose SettingsSchema rejected a new settings key
// silently fell back to last-known-good. Legacy generation pins upgrade in
// place; any command whose shape is not a supported fleet gate invocation
// — foreign path prefixes, sibling private harnesses, markers buried in
// arguments — is foreign and preserved verbatim. Rollback
// surface = the symlink itself (flip it; the wiring keeps resolving).
// Per-lane `-c` overrides were the spec's preference but remain unverified
// (codex exec was permission-blocked in the implementing session); the
// hooks.json merge is the proven, working surface on this machine.
//
//   bun gate-wire-codex.ts           # merge the wiring (idempotent)
//   bun gate-wire-codex.ts --check   # exit 0 wired / 1 not (stale pin = 1)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HOME = process.env.HOME ?? "";
const FILE = process.env.SUSPENDERS_CODEX_HOOKS ?? `${HOME}/.codex/hooks.json`;
const BUN = process.execPath;
const GATE_LOCAL = `${import.meta.dir}/../../gate.ts`;
// The stable install symlink → the active generation. Absent (dev runs,
// bare tests) → pin this checkout: identical at install time, because
// wire.ts itself runs from the active generation.
const GATE_STABLE = `${HOME}/.claude/hooks/suspenders/.harness/packages/suspenders/hooks/gate.ts`;
const INSTALLED = existsSync(GATE_STABLE);
const GATE = INSTALLED ? GATE_STABLE : GATE_LOCAL;
const HOOKS_ROOT = `${HOME}/.claude/hooks/`;

// Managed-command recognition (W2961, reviewer-hardened twice). Ownership
// rides the COMMAND SHAPE, never a substring: a supported generated
// command is `<bun> <gate.ts> codex <mode>` — take the gate PATH ARGUMENT
// (token 2), lexically normalize it (legacy pins carry
// dialects/codex/../../gate.ts), then match ANCHORED: exactly this
// generation's gate (the stable install symlink when installed, this
// checkout otherwise), or a single recognized `suspenders.generation-*`
// dir + exact suffix (a stale previous install — upgraded in place). A
// marker buried in other arguments/comments, a foreign path PREFIX
// (/foreign-prefix<root>/…), or an unrelated dir under a
// generation-looking name (suspenders.generation-x/unrelated/gate.ts)
// confers NOTHING — unknown shapes are preserved verbatim.
const normPath = (p: string): string => {
	const segs: string[] = [];
	p.split("/").forEach((seg, i) => {
		if (seg === "..") segs.pop();
		else if (seg !== "." && !(seg === "" && i > 0)) segs.push(seg);
	});
	return segs.join("/") || "/";
};
// gate-path argument of a supported generated command; anything else is
// foreign (undefined) — markers elsewhere on the line confer nothing. Fix-5
// (root #123977): token 1 must be a bun interpreter — `echo <gate-path> codex
// pre-tool` PRINTS the path, it does not invoke Fleet; ownership by gate-path
// alone deleted that legal foreign command.
const gateArg = (c: string): string | undefined => {
	const parts = c.trim().split(/\s+/);
	const g = parts[1];
	return parts.length >= 4 &&
		/(^|\/)bun(\.exe)?$/.test(parts[0] ?? "") &&
		parts[2] === "codex" &&
		typeof g === "string" &&
		g.endsWith("/gate.ts")
		? g
		: undefined;
};
const stableCmd = (c: string): boolean => {
	const a = gateArg(c);
	return a !== undefined && normPath(a) === normPath(GATE);
};
// gen pin = HOOKS_ROOT + `suspenders.generation-<id>` + `/<REL_GATE>`,
// anchored by SEGMENT SHAPE (round-3 review): exactly ONE generation dir
// between the hooks root and .harness — nested unrelated dirs
// (suspenders.generation-x/unrelated/.harness/…) are foreign, and so is any
// foreign prefix of the same LENGTH as the root (round-4: the gen tail is
// only examined after the path provably starts with the root).
const GEN_PREFIX = "suspenders.generation-";
const genCmd = (c: string): boolean => {
	const a = gateArg(c);
	if (a === undefined) return false;
	const np = normPath(a);
	// round-4 (root #123853): a foreign prefix of the same LENGTH as
	// HOOKS_ROOT followed by a gen-shaped tail sliced to an exact gen pin —
	// the entry got owned and deleted. The path must actually START WITH the
	// root before the slice; the trailing "/" in HOOKS_ROOT is the segment
	// boundary, so a same-length foreign prefix (`hooksX/…`) stays foreign.
	if (!np.startsWith(HOOKS_ROOT)) return false;
	const segs = np.slice(HOOKS_ROOT.length).split("/");
	const g = segs[0];
	return (
		segs.length === 6 &&
		typeof g === "string" &&
		g.startsWith(GEN_PREFIX) &&
		g.length > GEN_PREFIX.length &&
		segs[1] === ".harness" &&
		segs.slice(2).join("/") === "packages/suspenders/hooks/gate.ts"
	);
};
const managedCmd = (c: string): boolean => stableCmd(c) || genCmd(c);

// event → gate.ts codex <mode>: the adapter's one switch (gates/codex.ts)
const WIRING: Array<[string, string]> = [
	["PreToolUse", "codex pre-tool"],
	["PostToolUse", "codex post-tool"],
	["SessionStart", "codex session"],
	["Stop", "codex stop"],
	["SessionEnd", "codex session-end"],
];

type HookCmd = { type: string; command: string };
type HookEntry = { matcher?: string; hooks: HookCmd[] };

const read = (): Record<string, unknown> => {
	try {
		return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
};

const run = (): number => {
	const doc = read();
	const hooks = (doc.hooks ?? {}) as Record<string, HookEntry[]>;
	const check = process.argv[2] === "--check";
	// evaluate against the file AS IT IS — the loop below would add our
	// entries in memory and make every file look wired. A legacy
	// generation-pinned entry is stale, never wired (W2961).
	const wiredNow = WIRING.every(([event]) =>
		(hooks[event] ?? []).some(
			(e) =>
				Array.isArray(e.hooks) &&
				e.hooks.some(
					(h) => typeof h?.command === "string" && stableCmd(h.command),
				),
		),
	);
	// stale detection must read the file AS IT IS too — the rewrite loop
	// below replaces managed entries in memory (a --check run never writes,
	// but it still mutates the in-memory doc)
	const staleNow = WIRING.some(([event]) =>
		(hooks[event] ?? []).some(
			(e) =>
				Array.isArray(e.hooks) &&
				e.hooks.some(
					(h) => typeof h?.command === "string" && genCmd(h.command),
				),
		),
	);
	let changed = false;
	for (const [event, mode] of WIRING) {
		const list = Array.isArray(hooks[event]) ? hooks[event] : [];
		const want = `${BUN} ${GATE} ${mode}`;
		// strip only INSTALL-MANAGED COMMANDS within each entry (round-3
		// review): a mixed entry {hooks:[ownedStable, user-own-tool]} keeps
		// the user command and its matcher metadata; an entry drops only
		// when no commands remain. Legacy gen pins upgrade in place.
		const kept = list.flatMap((e) => {
			if (!Array.isArray(e.hooks)) return [e];
			const rest = e.hooks.filter(
				(h) => !(typeof h?.command === "string" && managedCmd(h.command)),
			);
			return rest.length > 0 ? [{ ...e, hooks: rest }] : [];
		});
		const next = [...kept, { hooks: [{ type: "command", command: want }] }];
		// change = the final list differs from the initial one (strip-readd of
		// an identical entry is a no-op, not a change)
		if (JSON.stringify(next) !== JSON.stringify(list)) changed = true;
		hooks[event] = next;
	}
	if (check) {
		// stale priority: a mixed stable+stale file is NOT wired — the stale
		// pins stay executable and must be reported (reviewer finding)
		if (wiredNow && !staleNow) {
			console.log(`wired: ${FILE}`);
			return 0;
		}
		console.log(
			staleNow ? `stale generation pin: ${FILE}` : `not wired: ${FILE}`,
		);
		return 1;
	}
	if (changed) {
		mkdirSync(dirname(FILE), { recursive: true });
		writeFileSync(FILE, `${JSON.stringify({ ...doc, hooks }, null, 2)}\n`);
		console.log(
			`wired ${WIRING.length} codex hook events → ${FILE} (user entries preserved)`,
		);
	} else {
		console.log(`already wired: ${FILE}`);
	}
	return 0;
};

process.exit(run());
