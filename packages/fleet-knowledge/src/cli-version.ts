// src/cli-version.ts — the --version face's one source (W2551): the
// INSTALLED generation revision from harness-receipt.json (the receipt
// sync-harness writes at the prefix root per generation) + the governor
// schema tip. One stable, machine-parsable line:
//   `<prog> revision=<sha|unknown> schema=<n>`
// Resolution walks UP from the running file (Bun realpaths import.meta.path,
// so the walk lands inside the generation dir the symlinked prefix serves)
// and reports `unknown` honestly when no receipt ancestor exists (repo
// checkouts, tests) — never a fabricated revision.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RECEIPT_FILE } from "./install-receipt-name.ts";
import { GOVDB_SCHEMA_VERSION } from "./schema-version.ts";

export function installedRevision(): string {
	let dir = dirname(import.meta.path);
	while (true) {
		const file = join(dir, RECEIPT_FILE);
		if (existsSync(file)) {
			try {
				const r = JSON.parse(readFileSync(file, "utf8")) as {
					revision?: unknown;
				};
				if (typeof r.revision === "string" && r.revision) return r.revision;
			} catch {} // present-but-unreadable: report unknown, don't hunt on
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "unknown";
}

export const versionLine = (prog: string): string =>
	`${prog} revision=${installedRevision()} schema=${GOVDB_SCHEMA_VERSION}`;
