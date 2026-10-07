import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { harvestUsage } from "../bin/usage-harvest.ts";

/** Produce review artifacts only. Aggregate legacy rows cannot prove which
 * producer owns them, so this tool never overwrites the live usage database. */
export function prepareUsageRebuild(
	sourcePath: string,
	transcripts: string,
	output: string,
) {
	const dir = resolve(output);
	mkdirSync(dir, { recursive: false, mode: 0o700 });
	const backup = join(dir, "before.sqlite");
	const report = join(dir, "transcript-metering.sqlite");
	const source = new Database(sourcePath, { readonly: true });
	try {
		// serialize is a consistent SQLite snapshot, including committed WAL.
		writeFileSync(backup, source.serialize(), { mode: 0o600, flag: "wx" });
		const db = new Database(report, { create: true });
		chmodSync(report, 0o600);
		try {
			for (const name of ["sessions", "facts", "usage_rollup"]) {
				const schema = source
					.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
					.get(name) as { sql: string } | null;
				if (!schema) throw new Error(`required source table missing: ${name}`);
				db.run(schema.sql);
			}
			const actors = source
				.query("SELECT sid,actor FROM sessions WHERE actor IS NOT NULL")
				.all() as { sid: string; actor: string }[];
			const insert = db.query(
				"INSERT INTO sessions (sid,project,role,started_at,hb,state,actor) VALUES (?, 'usage-rebuild', 'worker', 0, 0, 'CLOSED', ?)",
			);
			for (const row of actors) insert.run(row.sid, row.actor);
			const stats = harvestUsage(db, { root: transcripts });
			const totals = db
				.query(
					"SELECT SUM(requests) AS requests,SUM(in_tok) AS input,SUM(out_tok) AS output,SUM(cache_r) AS cacheRead,SUM(cache_c) AS cacheCreate FROM usage_rollup",
				)
				.get();
			const manifest = {
				version: 2,
				source: resolve(sourcePath),
				transcripts: resolve(transcripts),
				backup,
				report,
				stats,
				totals,
				applyAllowed: false,
				reason:
					"Transcript-only evidence. Legacy aggregate ownership and non-transcript producers require reconciliation before any live replacement.",
			};
			writeFileSync(
				join(dir, "manifest.json"),
				JSON.stringify(manifest, null, 2),
				{ mode: 0o600, flag: "wx" },
			);
			return manifest;
		} finally {
			db.close();
		}
	} finally {
		source.close();
	}
}

if (import.meta.main) {
	const [source, transcripts, output] = process.argv.slice(2);
	if (!source || !transcripts || !output)
		throw new Error(
			"usage: bun usage-rebuild.ts <source-db> <transcripts-root> <new-private-output-dir>; offline review artifacts only",
		);
	console.log(
		JSON.stringify(prepareUsageRebuild(source, transcripts, output), null, 2),
	);
}
