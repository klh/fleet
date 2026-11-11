#!/usr/bin/env bun
// hooks/bin/gate-wire-codex.ts — merge-not-clobber codex hook wiring (W73,
// generation-stable since W2961). Merges the five suspenders gate
// registrations into ~/.codex/hooks.json (or $SUSPENDERS_CODEX_HOOKS),
// preserving every entry that is not ours. Managed entries are recognized
// by their `gate.ts codex ` marker; user entries are never touched.
// W2961: the managed command rides the STABLE install symlink
// (~/.claude/hooks/suspenders), never a pinned generation dir — every
// install re-pinning its own import.meta.dir staled the previous binding,
// so a later generation whose SettingsSchema rejected a new settings key
// silently fell back to last-known-good. Legacy generation pins upgrade in
// place; a marker-bearing command OUTSIDE the install root is an
// intentional active-session pin and is preserved verbatim. Rollback
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
const MARK = "gate.ts codex ";
const BUN = process.execPath;
const GATE_LOCAL = `${import.meta.dir}/../../gate.ts`;
// The stable install symlink → the active generation. Absent (dev runs,
// bare tests) → pin this checkout: identical at install time, because
// wire.ts itself runs from the active generation.
const GATE_STABLE = `${HOME}/.claude/hooks/suspenders/.harness/packages/suspenders/hooks/gate.ts`;
const INSTALLED = existsSync(GATE_STABLE);
const GATE = INSTALLED ? GATE_STABLE : GATE_LOCAL;
const HOOKS_ROOT = `${HOME}/.claude/hooks/`;

// Managed-command shapes (W2961). With an install present (the stable
// symlink resolves) the contract is strict: STABLE rides the symlink
// (current), GEN rides a suspenders.generation-* dir (a stale previous
// install — upgraded in place), FOREIGN carries the marker outside the
// install root (an intentional active-session pin — never touched).
// Without an install there is no root to distinguish against: any marker
// command is managed — the original W73 contract.
const stableCmd = (c: string): boolean =>
	c.includes(MARK) && (!INSTALLED || c.includes(`${HOOKS_ROOT}suspenders/`));
const managedCmd = (c: string): boolean =>
	c.includes(MARK) && (!INSTALLED || c.includes(HOOKS_ROOT));
const staleGenCmd = (c: string): boolean =>
	INSTALLED &&
	c.includes(MARK) &&
	c.includes(`${HOOKS_ROOT}suspenders.generation-`);

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
					(h) => typeof h?.command === "string" && staleGenCmd(h.command),
				),
		),
	);
	let changed = false;
	for (const [event, mode] of WIRING) {
		const list = Array.isArray(hooks[event]) ? hooks[event] : [];
		const want = `${BUN} ${GATE} ${mode}`;
		// strip only INSTALL-MANAGED entries — stable + stale generation pins
		// (the pin upgrades in place). Foreign marker-bearing entries (an
		// intentional active-session pin) and user entries are never touched.
		const kept = list.filter(
			(e) =>
				!Array.isArray(e.hooks) ||
				!e.hooks.some(
					(h) => typeof h?.command === "string" && managedCmd(h.command),
				),
		);
		const next = [...kept, { hooks: [{ type: "command", command: want }] }];
		// change = the final list differs from the initial one (strip-readd of
		// an identical entry is a no-op, not a change)
		if (JSON.stringify(next) !== JSON.stringify(list)) changed = true;
		hooks[event] = next;
	}
	if (check) {
		if (wiredNow) {
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
