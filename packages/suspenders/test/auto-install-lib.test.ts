// test/auto-install-lib.test.ts — W1243: the W779 heartbeat passed the fleet
// root where install.sh does not live (127-forever ticks — the stale-harness
// poisoning stood unhealed all day); the lib resolves the install dir and the
// heartbeat argv pins the package root.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetRootOf, installScriptDir } from "../scripts/lib/auto-install.ts";

test("installScriptDir falls back to packages/suspenders when install.sh is absent (W1243)", () => {
	const root = mkdtempSync(join(tmpdir(), "auto-install-lib-"));
	try {
		expect(installScriptDir(root)).toBe(join(root, "packages/suspenders"));
		mkdirSync(join(root, "packages/suspenders"), { recursive: true });
		writeFileSync(join(root, "packages/suspenders/install.sh"), "#!/bin/sh\n");
		expect(installScriptDir(root)).toBe(join(root, "packages/suspenders"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("installScriptDir passes a package root through unchanged (W1243)", () => {
	const root = mkdtempSync(join(tmpdir(), "auto-install-lib-"));
	try {
		writeFileSync(join(root, "install.sh"), "#!/bin/sh\n");
		expect(installScriptDir(root)).toBe(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fleetRootOf splits a package path and passes anything else through", () => {
	expect(fleetRootOf("/fleet/packages/suspenders")).toBe("/fleet");
	expect(fleetRootOf("/fleet")).toBe("/fleet");
});
