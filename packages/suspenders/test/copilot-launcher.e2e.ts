// test/copilot-launcher.test.ts — W918.5: the PATH-stable copilot launcher
// (hooks/bin/copilot.ts) resolves the raw @github/copilot platform binary
// without node on PATH. Units: version-rank ordering, fixture-HOME
// resolution, env override.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCopilotBinary, versionRank } from "../hooks/bin/copilot.ts";

const platformBinary = (home: string, version: string): string =>
	join(
		home,
		".nvm/versions/node",
		version,
		"lib/node_modules/@github/copilot/node_modules/@github/copilot-darwin-arm64/copilot",
	);

test.describe("copilot launcher (W918.5)", () => {
	test("versionRank parses numeric version tails", () => {
		expect(versionRank("versions/node/v26.3.1/lib/x")).toEqual([26, 3, 1]);
		expect(versionRank("versions/node/v27.0.0-rc.1/lib/x")).toEqual([
			27, 0, 0, 1,
		]);
	});

	test("resolves the newest nvm node version's platform binary", async () => {
		const home = mkdtempSync(join(tmpdir(), "fleet-copilot-home-"));
		for (const version of ["v22.14.0", "v26.3.1"]) {
			const path = platformBinary(home, version);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
		}
		const resolved = await resolveCopilotBinary(home, "darwin-arm64");
		expect(resolved).toBe(platformBinary(home, "v26.3.1"));
		rmSync(home, { recursive: true, force: true });
	});

	test("returns null when nothing is installed", async () => {
		const home = mkdtempSync(join(tmpdir(), "fleet-copilot-home-"));
		const resolved = await resolveCopilotBinary(home, "darwin-arm64");
		expect(resolved).toBeNull();
		rmSync(home, { recursive: true, force: true });
	});

	test("SUSPENDERS_COPILOT_BIN override wins when it exists", async () => {
		const home = mkdtempSync(join(tmpdir(), "fleet-copilot-home-"));
		const override = platformBinary(home, "v99.0.0");
		mkdirSync(dirname(override), { recursive: true });
		writeFileSync(override, "#!/bin/sh\n", { mode: 0o755 });
		process.env.SUSPENDERS_COPILOT_BIN = override;
		try {
			const resolved = await resolveCopilotBinary(home, "darwin-arm64");
			expect(resolved).toBe(override);
		} finally {
			delete process.env.SUSPENDERS_COPILOT_BIN;
		}
	});
});
