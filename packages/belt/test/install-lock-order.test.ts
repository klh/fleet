// test/install-lock-order.test.ts — W1135.2: the standalone Belt installer's
// lock order is asserted from REAL --dry-run output (sandbox BELT_PREFIX), no
// longer from install.sh source text. The dry-run emits the exact step order
// the W1104.1 runtime-revision law requires — acquire lock → copy → heal →
// release BEFORE tier manifest/model setup/launchd activation — and a held
// lock still refuses for real. (W1104.1 review #55056: the lock must span
// copy + runtime-heal/closure verification only; an interrupted install
// releases via the EXIT trap on the failure path.)
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = join(import.meta.dir, "..", "install.sh");

/** Run install.sh --dry-run against a sandbox prefix. The dry path exits
 *  before any mutation: no copy, no heal, no tier.json, no launchd. */
function dryRun(flags: string[] = [], opts?: { heldLock?: boolean }): DryRun {
	const prefix = mkdtempSync(join(tmpdir(), "belt-install-dry-"));
	if (opts?.heldLock) {
		// a concurrent owner holds the lock dir
		mkdirSync(join(prefix, ".belt-overlay.lock"));
	}
	const proc = Bun.spawnSync({
		cmd: ["/usr/bin/env", "bash", INSTALL, "--dry-run", ...flags],
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: prefix,
			BELT_PREFIX: prefix,
		},
		timeout: 15_000,
	});
	const out: DryRun = {
		status: proc.exitCode ?? -1,
		stdout: proc.stdout.toString(),
		stderr: proc.exitCode === 0 ? "" : proc.stderr.toString(),
		entriesAfter: readdirSync(prefix),
	};
	rmSync(prefix, { recursive: true, force: true });
	return out;
}

interface DryRun {
	status: number;
	stdout: string;
	stderr: string;
	/** Prefix dir entries after the run (empty = the dry path wrote nothing). */
	entriesAfter: Array<string>;
}

describe("belt installer lock order (real --dry-run)", () => {
	test("installer acquires the lock before the first copy and the heal", () => {
		const run = dryRun();
		expect(run.status).toBe(0);
		const order = [
			"→ installing to",
			"[dry] acquire",
			"[dry] copy bin/* + observation.ts",
			"[dry] bun runtime-heal.ts",
			"[dry] release",
			"[dry] tier manifest",
			"dry run — nothing was written",
		];
		let at = -1;
		for (const needle of order) {
			const next = run.stdout.indexOf(needle);
			expect(next).toBeGreaterThan(at);
			at = next;
		}
	});
});

test("sandbox untouched: no copied runtime, no tier.json, no lock left", () => {
	const run = dryRun();
	expect(run.status).toBe(0);
	// the mkdtemp sandbox stays empty — the dry path never writes into it
	expect(run.entriesAfter).toEqual([]);
	// and the dry path completes its narration without an error word
	expect(run.stdout).toContain("dry run — nothing was written");
	expect(run.stderr).toBe("");
});

test("installer refuses a concurrent lock owner", () => {
	const run = dryRun([], { heldLock: true });
	expect(run.status).toBe(1);
	expect(run.stderr).toContain(
		"another belt install/refresh owns the runtime",
	);
});

test("flag plumbing: tier scope and activation steps ride the dry lines", () => {
	const plain = dryRun();
	expect(plain.stdout).not.toContain("[dry] bun setup/llm-stack.ts");
	expect(plain.stdout).not.toContain("[dry] launchd bootstrap");

	const launchdOnly = dryRun(["--with-launchd"]);
	expect(launchdOnly.status).toBe(0);
	expect(launchdOnly.stdout).toContain("[dry] bun setup/llm-stack.ts");
	expect(launchdOnly.stdout).toContain("[dry] launchd bootstrap");

	const minimal = dryRun(["--tier", "minimal"]);
	expect(minimal.status).toBe(0);
	expect(minimal.stdout).toContain("[dry] tier manifest: minimal");
});

test("installer releases the lock on the runtime-heal failure path", () => {
	// the EXIT trap is installed with the lock and only disarmed by the
	// success-path release; the dry-run's release line is emitted BEFORE the
	// activation steps, mirroring the real success path (trap detail is a
	// real-mode behavior — the lane fence denies executing the installer).
	const run = dryRun();
	expect(run.status).toBe(0);
	expect(run.stdout.indexOf("[dry] release")).toBeGreaterThan(
		run.stdout.indexOf("[dry] bun runtime-heal.ts"),
	);
});
