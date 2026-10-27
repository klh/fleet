#!/usr/bin/env bun
// hooks/bin/copilot.ts — PATH-stable copilot launcher (W918.5). The npm
// wrapper (~/.nvm/.../bin/copilot) is a `#!/usr/bin/env node` shim: it dies
// in launchd/lane contexts that run a bare PATH (W626). This launcher
// resolves the raw platform binary directly and execs it — no node on PATH:
//
//   1. $SUSPENDERS_COPILOT_BIN — explicit override (config-over-code)
//   2. newest ~/.nvm/versions/node/*/lib/node_modules/@github/copilot/
//      node_modules/@github/copilot-<platform>-<arch>/copilot
//
// Published as a regular-file shim by ensureShims (symlink shims are a
// refused fork), same exec form as the coord/work/dispatch shims.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PLATFORM = `${process.platform}-${process.arch}`;

// "versions/node/v26.3.1/…" → [26, 3, 1]; NaN-safe for prerelease tails.
export const versionRank = (path: string): number[] =>
	path
		.split("/")[2]
		.slice(1)
		.split(".")
		.map((part) => (Number.isNaN(Number(part)) ? 0 : Number(part)));

/** Resolve the copilot platform binary; null when nothing is installed. */
export const resolveCopilotBinary = async (
	home: string,
	platform = PLATFORM,
): Promise<string | null> => {
	const override = process.env.SUSPENDERS_COPILOT_BIN;
	if (override) return existsSync(override) ? override : null;
	const glob = new Bun.Glob(
		`.nvm/versions/node/*/lib/node_modules/@github/copilot/node_modules/@github/copilot-${platform}/copilot`,
	);
	const hits = await Array.fromAsync(glob.scan({ cwd: home, onlyFiles: true }));
	if (hits.length === 0) return null;
	hits.sort((a, b) => {
		const va = versionRank(a);
		const vb = versionRank(b);
		for (let i = 0; i < Math.max(va.length, vb.length); i++) {
			const delta = (vb[i] ?? 0) - (va[i] ?? 0);
			if (delta !== 0) return delta;
		}
		return 0;
	});
	return join(home, hits[0]);
};

if (import.meta.main) {
	const binary = await resolveCopilotBinary(process.env.HOME ?? "");
	if (!binary) {
		console.error(
			`copilot: no platform binary found (looked for @github/copilot-${PLATFORM} under ~/.nvm; set SUSPENDERS_COPILOT_BIN to override) — reinstall with npm install -g @github/copilot`,
		);
		process.exit(127);
	}
	const res = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
	if (res.signal) process.exit(1);
	process.exit(res.status ?? 1);
}
