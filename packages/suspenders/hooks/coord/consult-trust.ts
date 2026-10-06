import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { GovernorStore } from "../lib/govdb.ts";

/** Conservative version: any tracked edit invalidates earlier evidence. */
export function consultVersion(): string | null {
	const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (head.exitCode !== 0) return null;
	const diff = Bun.spawnSync(["git", "diff", "--no-ext-diff", "HEAD"], {
		stdout: "pipe",
		stderr: "pipe",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (diff.exitCode !== 0) return null;
	// New untracked source files can change the answer too. Bound the scan;
	// an unknown version disables reuse rather than trusting incomplete state.
	const untracked = Bun.spawnSync(
		["git", "ls-files", "--others", "--exclude-standard", "-z"],
		{ stdout: "pipe", stderr: "pipe", maxBuffer: 1024 * 1024 },
	);
	if (untracked.exitCode !== 0) return null;
	const files = untracked.stdout.toString().split("\0").filter(Boolean).sort();
	if (files.length > 1000) return null;
	const hash = createHash("sha256").update(diff.stdout);
	let bytes = diff.stdout.byteLength;
	try {
		for (const file of files) {
			const size = statSync(file).size;
			bytes += size;
			if (bytes > 4 * 1024 * 1024) return null;
			hash
				.update(JSON.stringify(file))
				.update("\0")
				.update(readFileSync(file))
				.update("\0");
		}
	} catch {
		return null;
	}
	return `${head.stdout.toString().trim()}:${hash.digest("hex")}`;
}

export function ensureConsultTrust(db: GovernorStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS consult_trust (
 kb_id INTEGER PRIMARY KEY, scope TEXT NOT NULL, version TEXT NOT NULL,
 evidence TEXT NOT NULL DEFAULT '', verified_by TEXT, verified_at INTEGER,
 resolved INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0
 )`);
	db.run(`CREATE TABLE IF NOT EXISTS consult_reuse (
 consult_id INTEGER PRIMARY KEY, kb_id INTEGER NOT NULL
 )`);
	db.run(`CREATE TABLE IF NOT EXISTS consult_feedback (
 consult_id INTEGER PRIMARY KEY, outcome TEXT NOT NULL, evidence TEXT NOT NULL,
 source TEXT NOT NULL, recorded_at INTEGER NOT NULL
 )`);
}
