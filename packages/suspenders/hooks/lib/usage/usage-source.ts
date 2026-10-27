import type { Database } from "bun:sqlite";

export function verifiedUsageActive(db: Database): boolean {
	const table = db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_migration_state'",
		)
		.get();
	return (
		!!table &&
		!!db
			.query("SELECT 1 FROM usage_migration_state WHERE id=1 AND active=1")
			.get()
	);
}

export function usageRollupSource(db: Database): string {
	return verifiedUsageActive(db) ? "usage_verified_rollup" : "usage_rollup";
}
