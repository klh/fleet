// test/bypass-gate.test.ts — W1119.2 static bypass gate. The migration
// retired every direct completion leg in the dispatch + maintenance
// inference surface (dispatch, soak, fallback-drill, prompt-bench,
// llm-keepwarm): every real model completion rides the Buckle gate
// (hooks/lib/inference-buckle.ts) with a scoped key. This law-guard keeps
// it retired: a tracked non-test suspenders .ts that carries BOTH a
// completion-path literal and a direct-tier endpoint (:890x, :4000, :4100)
// must be a pinned allowlist entry — new bypasses fail CI, and an entry
// whose file stopped carrying the shape must be dropped (the list cannot
// rot silently). The gate surface includes the board and deploy trees, so
// a new leg anywhere in the package reds here even while its own migration
// (W1119 parent / W1119.1) is still in flight.
//
// Installer/runtime parity rides the same suite: the gated runtime faces
// fleet-loop fires (llm-keepwarm, soak, fallback-drill) must exist in the
// payload trees the installer archives, bundle clean, and be named by the
// installer's ENTRYPOINTS validation — what the runtime runs is exactly
// what the installer ships and validates.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAINTENANCE_TASKS } from "../hooks/lib/fleet-loop/maintenance.ts";
import { ENTRYPOINTS } from "../scripts/sync-harness.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const PKG = join(ROOT, "packages", "suspenders");
/** Direct-tier endpoints a completion must never target outside the gate.
 *  :4101 is the buckle front itself — riding it IS the compliant path. */
const DIRECT_PORTS = /:890\d|:4000|:4100(?!\d)/;
const COMPLETION_PATH = /\/v1\/(?:chat\/completions|messages|completions)\b/;

/** Files pinned as carrying the banned shape, with the reason each stays.
 *  Exact equality with the scan: a migrated file drops its entry; an
 *  unpinned offender fails the gate. */
const BYPASS_ALLOWLIST: Array<[string, string]> = [
	[
		"deploy/e2e/run-e2e.ts",
		"deploy e2e harness — stub direct legs are the fixture's point",
	],
	[
		"deploy/e2e/stub-tier.ts",
		"deploy e2e stub tier — fixture endpoint, never a real completion",
	],
	[
		"hooks/bin/advise.ts",
		"W1119.1 scope — advise migrates in its own lane; entry drops then",
	],
	[
		"hooks/bin/fallback-drill.ts",
		"zaiDark reachability probe (GET) + retired-leg comments; the completion rides buckleChat",
	],
	[
		"hooks/bin/oracle.ts",
		"W1119.1 scope — oracle migrates in its own lane; entry drops then",
	],
	[
		"hooks/board/decide-eval.ts",
		"W1119 parent scope — board migrations land with the parent item",
	],
	[
		"hooks/board/orch.ts",
		"W1119 parent scope — board migrations land with the parent item",
	],
	[
		"hooks/board/prompt-transform.ts",
		"W1119 parent scope — board migrations land with the parent item",
	],
	[
		"hooks/board/routes-actions.ts",
		"W1119 parent scope — board migrations land with the parent item",
	],
	[
		"hooks/board/suggest.ts",
		"W1119 parent scope — board migrations land with the parent item",
	],
	[
		"hooks/lib/inference-buckle.ts",
		"THE boundary — direct ports appear only in the fail-closed law header comment",
	],
	[
		"hooks/lib/oracle-legs.ts",
		"W1119.1 scope — the pinned oracle route; entry drops when W1119.1 lands",
	],
	[
		"scripts/dispatch-watchdog.ts",
		"gated front probe (:4101 /w/<sid>/v1/messages) + tcp:4100 liveness target; no direct leg",
	],
];

const ALLOWED = BYPASS_ALLOWLIST.map(([f]) => f).sort();

function trackedSuspendersTs(): string[] {
	const out = Bun.spawnSync(["git", "ls-files", "packages/suspenders"], {
		cwd: ROOT,
	});
	if (out.exitCode !== 0)
		throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
	return new TextDecoder()
		.decode(out.stdout)
		.split("\n")
		.map((s) => s.trim().replace(/^packages\/suspenders\//, ""))
		.filter(
			(f) =>
				f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("test/"),
		);
}

function carriesBypass(text: string): boolean {
	return DIRECT_PORTS.test(text) && COMPLETION_PATH.test(text);
}

test("no direct-tier completion leg outside the pinned allowlist (W1119.2)", () => {
	const found = trackedSuspendersTs()
		.filter((f) => existsSync(join(PKG, f)))
		.filter((f) => carriesBypass(readFileSync(join(PKG, f), "utf8")));
	expect(
		found.sort(),
		"new direct completion leg — migrate it onto buckleChat (hooks/lib/inference-buckle.ts) or argue a pinned entry in bypass-gate.test.ts",
	).toEqual(ALLOWED);
});

test("scan has teeth (real pinned population and retired shapes fire)", () => {
	// the allowlist is not aspirational: every entry must keep firing
	expect(trackedSuspendersTs().length).toBeGreaterThan(300);
	expect(ALLOWED.length).toBeGreaterThanOrEqual(13);
	// the retired shapes fire the detector
	const retired = [
		'fetch("http://127.0.0.1:8902/v1/chat/completions")',
		"fetch((base) + '/v1/messages'); // base = http://127.0.0.1:4000",
		"POST http://127.0.0.1:4100/v1/chat/completions",
	];
	for (const shape of retired) expect(carriesBypass(shape)).toBe(true);
	// compliant shapes stay silent: gate-front probe and port-less boundary
	expect(
		carriesBypass("fetch((front) + '/w/sid/v1/messages') // front=:4101"),
	).toBe(false);
	expect(carriesBypass("POST (base.origin) + '/v1/messages'")).toBe(false);
});

test("gated runtime faces ship, bundle clean, and ride installer validation", async () => {
	const FACES = [
		"hooks/bin/llm-keepwarm.ts",
		"hooks/bin/fallback-drill.ts",
		"hooks/bin/soak.ts",
	];
	for (const face of FACES) {
		// ships: the face lives in the payload trees the installer archives
		const rel = `packages/suspenders/${face}`;
		expect(
			existsSync(join(ROOT, rel)),
			`runtime face missing from the payload trees: ${face}`,
		).toBe(true);
		// rides installer validation: named by sync-harness ENTRYPOINTS
		expect(
			ENTRYPOINTS,
			`${face} must be a sync-harness ENTRYPOINT (install-time graph validation)`,
		).toContain(face);
		// bundles clean: the gated import graph resolves (same check the
		// installer's validate() runs on every ENTRYPOINT)
		const build = await Bun.build({
			entrypoints: [join(ROOT, rel)],
			target: "bun",
			write: false,
			throw: false,
		});
		expect(
			build.success,
			`${face} import graph failed: ${build.logs.map(String).join("; ").slice(0, 500)}`,
		).toBe(true);
	}
	// and the heartbeat that fires them lists exactly these faces
	const keepwarm = MAINTENANCE_TASKS.find((t) => t.name === "llm-keepwarm");
	const soak = MAINTENANCE_TASKS.find((t) => t.name === "soak");
	expect(keepwarm?.argv("/", "/").at(-1)).toContain("llm-keepwarm.ts");
	expect(soak?.argv("/", "/").at(-1)).toContain("hooks/bin/soak.ts");
});

test("every fleet-loop maintenance face ships in the payload trees", () => {
	for (const task of MAINTENANCE_TASKS) {
		const argv0 = task.argv("/", "/")[0];
		// faces resolve inside the suspenders payload the installer archives
		// (SOURCE_PATHS cover packages/suspenders/{hooks,scripts,deploy})
		expect(
			/^\/(hooks|scripts|deploy)\//.test(argv0),
			`${task.name} face escapes the payload trees: ${argv0}`,
		).toBe(true);
	}
});
