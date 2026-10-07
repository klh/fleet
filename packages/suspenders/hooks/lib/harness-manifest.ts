// hooks/lib/harness-manifest.ts — the one source of truth for what the
// installed harness prefix must contain (W420). Consumers: scripts/
// sync-harness.ts (staged sync build) and hooks/bin/monitor.ts (repo-vs-
// prefix drift surface). Sharing the sets here stops the sync code and the
// drift report from forking — the exact failure mode this module prevents.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Harness entries published from the .harness payload (symlinked in). */
export const HOOK_ITEMS = [
	"bin",
	"lib",
	"board-html",
	"coord",
	"board",
	"gates",
	"launchd",
	"rules",
	"gate.ts",
	"session-start.ts",
	"session-end.ts",
	"knowledgeworker.md",
	"statusline.ts",
	"subagent-statusline.ts",
];

/**
 * Generated/runtime entries `install.sh --prune` keeps when mirroring the
 * prefix: machine-produced, never repo content, so a mirror must not count
 * them as forks (W420 allowlist).
 */
export const PRUNE_ALLOWLIST = new Set([
	"governor.db",
	"bun.lock",
	"node_modules",
	".fleet",
]);

/** Receipt filename pinning revision + payload checksum per generation. */
export const RECEIPT_FILE = "harness-receipt.json";

/** Every top-level prefix entry the installer manages (synced, linked or receipt). */
export const MANAGED_PREFIX_ENTRIES = new Set([
	...HOOK_ITEMS,
	".harness",
	"scripts",
	"local-llm",
	"blam",
	"node_modules",
	"package.json",
	"bun.lock",
	RECEIPT_FILE,
]);

/**
 * Payload checksum exactly as the receipt pins it at install time: sorted
 * walk of the .harness payload (node_modules skipped), hashing path + NUL +
 * content + NUL. Shared by the sync that writes the receipt and the monitor
 * drift check that verifies it, so the scheme cannot drift apart.
 */
export function payloadChecksum(dir: string): string {
	const hash = new Bun.CryptoHasher("sha256");
	for (const file of [
		...new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true }),
	]
		.filter((file) => !file.includes("node_modules/"))
		.sort()) {
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(join(dir, file)))
			.update("\0");
	}
	return hash.digest("hex");
}
