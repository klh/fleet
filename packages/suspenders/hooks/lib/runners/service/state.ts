import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { sqliteStore } from "../control/store.ts";
import { acquireHostWriter } from "../durable/host-writer.ts";
import { existingEntry, privateDirectory } from "../durable/private-paths.ts";

export function requirePrivateFile(info: ReturnType<typeof fstatSync>) {
	if (
		!info.isFile() ||
		info.nlink !== 1 ||
		!process.getuid ||
		info.uid !== process.getuid() ||
		(info.mode & 0o077) !== 0
	)
		throw new Error("runner.private_file_required");
}

/** The trusted host owns this database separately from the work graph. */
export async function openRunnerState(directory: string) {
	await privateDirectory(directory);
	const release = await acquireHostWriter(directory);
	try {
		const db = await openDatabase(directory);
		return {
			store: sqliteStore(db),
			async close() {
				try {
					db.close();
				} finally {
					await release();
				}
			},
		};
	} catch (error) {
		await release();
		throw error;
	}
}

async function openDatabase(directory: string) {
	const path = join(directory, "control.sqlite");
	for (const suffix of ["-journal", "-wal", "-shm"]) {
		const entry = await existingEntry(path + suffix);
		if (entry) requirePrivateFile(entry);
	}
	const descriptor = openSync(
		path,
		constants.O_CREAT |
			constants.O_RDWR |
			constants.O_NOFOLLOW |
			constants.O_NONBLOCK,
		0o600,
	);
	try {
		requirePrivateFile(fstatSync(descriptor));
	} finally {
		closeSync(descriptor);
	}
	return new Database(path);
}
