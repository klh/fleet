// test/dispatch-intent-help.test.ts — W1124.33: `dispatch intent <verb>
// --help` rides the intent family door (exact verb help with the prepare/
// apply evidence + safety semantics), the root usage enumerates the shipped
// verb specs (schema discovery), and help never mutates anything: no store
// open, no .fleet/.worktrees creation, zero buckle-front requests — even
// when --apply rides the argv. Spawns the REAL dispatch-next.ts (the
// installed-style CLI) in the shared scratch harness.
import { afterAll, afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INTENT_ROOT_HELP_ENTRY } from "../scripts/lib/launch-intent-cli.ts";
import { REGISTRY_ROOT_HELP_ENTRY } from "../scripts/lib/registry-cli.ts";
import { dispatchHarness, stubBuckle } from "./helpers/dispatch-harness.ts";

const { HOME, REPO, env, dispatchWith } = dispatchHarness(afterAll, {
	tag: "w1124-33-intent-help",
});
const front = stubBuckle();
const frontUrl = `http://127.0.0.1:${front.port}`;
// the scratch store lives only under the fixture HOME — its existence would
// mean a help invocation opened (and created) governor.db.
const storePath = join(HOME, ".cache", "claude-governor", "governor.db");

afterEach(() => {
	expect(front.calls).toEqual([]);
});

afterAll(() => {
	front.stop();
});

// verb-first spawn (the installed shim passes argv verbatim) and flag-first
// spawn (`--repo <dir>` rides ahead of the head — dispatchWith's form).
const DISPATCH = join(import.meta.dir, "..", "scripts", "dispatch-next.ts");
const verbFirst = (...args: string[]): { code: number; out: string } => {
	const p = spawnSync(process.execPath, [DISPATCH, ...args], {
		cwd: REPO,
		env: { ...env, SUSPENDERS_BUCKLE_FRONT: frontUrl },
		stdout: "pipe",
		stderr: "pipe",
	});
	// node:child_process sync spawns carry `status` (Bun.spawnSync: exitCode)
	return { code: p.status ?? 1, out: p.stdout.toString() };
};
const flagFirst = (...args: string[]): { code: number; out: string } => {
	const r = dispatchWith({ SUSPENDERS_BUCKLE_FRONT: frontUrl }, ...args);
	return { code: r.code, out: r.out };
};

test("exact verb help rides the intent family door (verb-first)", () => {
	const r = verbFirst("intent", "reconcile-birth", "--help");
	expect(r.code).toBe(0);
	// prepare/apply evidence + safety semantics, from the shipped verb spec
	expect(r.out).toContain(
		"usage: reconcile-birth --item <Wn> --evidence <0600-json> [--apply]",
	);
	expect(r.out).toContain("never authenticates a caller-supplied SID");
	expect(r.out).toContain("flags: --item --evidence --apply");
	// never the generic dispatch usage
	expect(r.out).not.toContain("Usage: dispatch [options]");
});

test("exact verb help rides the intent family door (flag-first)", () => {
	const r = flagFirst("intent", "reconcile-birth", "--help");
	expect(r.code).toBe(0);
	expect(r.out).toContain("usage: reconcile-birth");
	expect(r.out).toContain("never authenticates a caller-supplied SID");
	expect(r.out).not.toContain("Usage: dispatch [options]");
});

test("root help enumerates the shipped verb specs", () => {
	const r = verbFirst("--help");
	expect(r.code).toBe(0);
	expect(r.out).toContain("Usage: dispatch [options]");
	// schema discovery: the family entries interpolate verbatim from the
	// verb modules' shipped specs
	expect(r.out).toContain(INTENT_ROOT_HELP_ENTRY);
	expect(r.out).toContain(REGISTRY_ROOT_HELP_ENTRY);
});

test("family help lists every intent verb", () => {
	const r = verbFirst("intent", "--help");
	expect(r.code).toBe(0);
	expect(r.out).toContain("usage: inspect");
	expect(r.out).toContain("usage: reconcile-birth");
	expect(r.out).toContain("usage: fail");
	expect(r.out).not.toContain("Usage: dispatch [options]");
});

test("inspect --help rides the family door too", () => {
	const r = verbFirst("intent", "inspect", "--help");
	expect(r.code).toBe(0);
	expect(r.out).toContain("usage: inspect");
	expect(r.out).not.toContain("Usage: dispatch [options]");
});

test("--apply never beats --help and never touches state", () => {
	const r = verbFirst(
		"intent",
		"reconcile-birth",
		"--item",
		"W1",
		"--evidence",
		"e.json",
		"--apply",
		"--help",
	);
	expect(r.code).toBe(0);
	expect(r.out).toContain("usage: reconcile-birth");
	expect(existsSync(storePath)).toBe(false);
	expect(existsSync(join(REPO, ".fleet"))).toBe(false);
});

test("help never opens the store or creates fleet state", () => {
	expect(existsSync(storePath)).toBe(false);
	expect(existsSync(join(REPO, ".fleet"))).toBe(false);
	expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
});
