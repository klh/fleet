import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SpawnRow = { pid: number; startedAt: number; ram_gb?: number };
export type SpawnLedger = Record<string, SpawnRow>;

/** SQLite's process-shared writer lock covers the JSON check/reserve/spawn.
 * A crashed lock holder releases automatically; equal-time cold loads cannot
 * both spend the same available RAM. JSON stays compatible with W500 callers. */
export function withSpawnLedger<T>(
	path: string,
	action: (rows: SpawnLedger) => T,
): T {
	mkdirSync(dirname(path), { recursive: true });
	const lock = new Database(`${path}.lock.sqlite`);
	try {
		lock.exec("PRAGMA busy_timeout=2000");
		lock.exec("BEGIN IMMEDIATE");
		let rows: SpawnLedger = {};
		try {
			rows = JSON.parse(readFileSync(path, "utf8"));
			if (!rows || Array.isArray(rows) || typeof rows !== "object")
				throw new Error("invalid spawn ledger object");
			for (const row of Object.values(rows)) {
				if (
					!row ||
					!Number.isFinite(row.pid) ||
					row.pid <= 0 ||
					!Number.isFinite(row.startedAt) ||
					(row.ram_gb !== undefined &&
						(!Number.isFinite(row.ram_gb) || row.ram_gb < 0))
				)
					throw new Error("invalid spawn ledger reservation");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const result = action(rows);
		const staged = `${path}.${process.pid}.new`;
		writeFileSync(staged, JSON.stringify(rows), { mode: 0o600 });
		renameSync(staged, path);
		lock.exec("COMMIT");
		return result;
	} finally {
		lock.close();
	}
}

export function admitSpawn<T extends { pid: number }>(options: {
	path: string;
	port: number;
	budgetGb: number;
	guardGb: number;
	wiredGb: () => number;
	alive: (pid: number) => boolean;
	spawn: () => T;
	cancel?: (child: T) => void;
}): T {
	let child: T | undefined;
	try {
		return withSpawnLedger(options.path, (rows) => {
			for (const [port, row] of Object.entries(rows)) {
				if (!options.alive(row.pid)) delete rows[port];
			}
			if (rows[String(options.port)])
				throw new Error(
					`model :${options.port} already reserved by a live process`,
				);
			const reserved = Object.values(rows).reduce(
				(sum, row) => sum + (row.ram_gb ?? options.guardGb),
				0,
			);
			const projected = options.wiredGb() + reserved + options.budgetGb;
			if (!Number.isFinite(projected) || projected > options.guardGb)
				throw new Error(
					`model memory admission refused: projected ${projected.toFixed(1)}GB exceeds ${options.guardGb}GB`,
				);
			child = options.spawn();
			rows[String(options.port)] = {
				pid: child.pid,
				startedAt: Date.now(),
				ram_gb: options.budgetGb,
			};
			return child;
		});
	} catch (error) {
		if (child) options.cancel?.(child);
		throw error;
	}
}
