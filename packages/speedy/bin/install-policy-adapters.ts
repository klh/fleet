// Delegate to the canonical installer; one implementation in both layouts.
import { existsSync } from "node:fs";
import { join } from "node:path";
const candidates = [
	join(import.meta.dir, "../../suspenders/scripts/install-policy-adapters.ts"),
	join(
		process.env.SUSPENDERS_PREFIX ??
			`${process.env.HOME}/.claude/hooks/suspenders`,
		"scripts/install-policy-adapters.ts",
	),
];
const path = candidates.find(existsSync);
if (!path)
	throw new Error("Suspenders policy adapter installer is unavailable");
const proc = Bun.spawn([process.execPath, path, ...process.argv.slice(2)], {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await proc.exited);
