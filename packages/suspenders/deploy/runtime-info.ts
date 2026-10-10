#!/usr/bin/env bun
// deploy/runtime-info.ts — W443: report (and optionally gate) the runtime +
// embedded SQLite of the artifact this script runs IN. Deploy diagnostics must
// read the artifact, never the host sqlite3: bun VENDORS its SQLite
// amalgamation on Linux (the oven/bun images every hub container runs), while
// on macOS bun links the SYSTEM SQLite (Apple build — source id carries the
// aapl suffix). Ref: sqlite.org/wal.html#walresetbug — the WAL-reset race is
// present 3.7.0 → 3.51.2, fixed in 3.51.3, backported to 3.44.6/3.50.7. A
// version below the fix passes only with documented vendor-backport evidence
// (SQLITE_PATCH_EVIDENCE env).

import { Database } from "bun:sqlite";

const WAL_RESET_FIX = "3.51.3";

/** Three-component numeric version compare (missing fields = 0). */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Verified = at/after the fix version, or documented vendor backport. */
export function sqliteVerdict(
	sqlite: string,
	min: string = WAL_RESET_FIX,
	evidence?: string,
): { verified: boolean; reason: string } {
	if (compareVersions(sqlite, min) >= 0)
		return { verified: true, reason: `${sqlite} >= ${min} (WAL-reset fix)` };
	if (evidence)
		return {
			verified: true,
			reason: `${sqlite} with vendor backport evidence: ${evidence}`,
		};
	return {
		verified: false,
		reason: `${sqlite} < ${min} (WAL-reset fix; affected 3.7.0-3.51.2, no backport evidence)`,
	};
}

export interface RuntimeFacts {
	bun: string;
	sqlite: string;
	sourceId: string;
	platform: string;
}

/** Ask the bun:sqlite this process actually runs for its identity. */
export function runtimeFacts(): RuntimeFacts {
	const db = new Database(":memory:");
	try {
		const row = db
			.query("select sqlite_version() as v, sqlite_source_id() as s")
			.get() as { v: string; s: string };
		return {
			bun: Bun.version,
			sqlite: row.v,
			sourceId: row.s,
			platform: process.platform,
		};
	} finally {
		db.close();
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const check = args.includes("--check");
	const json = args.includes("--json");
	const minFlag = args.indexOf("--min");
	const min =
		minFlag >= 0 ? (args[minFlag + 1] ?? WAL_RESET_FIX) : WAL_RESET_FIX;
	const facts = runtimeFacts();
	const v = sqliteVerdict(facts.sqlite, min, process.env.SQLITE_PATCH_EVIDENCE);
	if (json) {
		console.log(
			JSON.stringify({ ...facts, min, verified: v.verified, reason: v.reason }),
		);
		if (check && !v.verified)
			console.error(`WAL-reset fix UNVERIFIED — ${v.reason}`);
	} else {
		console.log(
			`bun ${facts.bun} · SQLite ${facts.sqlite} (${facts.sourceId}) · ${facts.platform}`,
		);
		console.log(
			`WAL-reset fix: ${v.verified ? "verified" : "UNVERIFIED"} — ${v.reason}`,
		);
	}
	if (check && !v.verified) process.exit(1);
}

if (import.meta.main) main();
