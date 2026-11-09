import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { existingEntry, privateDirectory } from "./private-paths.ts";

/** A transaction on a separate, private file holds the OS lock for this writer. */
export async function acquireHostWriter(
	directory: string,
): Promise<() => Promise<void>> {
	await privateDirectory(directory);
	const path = join(await realpath(directory), "writer.sqlite");
	if (!(await existingEntry(path))) {
		try {
			await (await open(path, "wx", 0o600)).close();
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
		}
	}
	for (const suffix of ["", "-wal", "-shm", "-journal"]) {
		const info = suffix
			? await existingEntry(path + suffix)
			: await lstat(path);
		if (
			info &&
			(!info.isFile() ||
				info.nlink !== 1 ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o077) !== 0)
		)
			throw new Error("Durable writer file must be private to its POSIX owner");
	}
	const db = new DatabaseSync(path);
	try {
		db.exec("BEGIN IMMEDIATE");
	} catch (error) {
		db.close();
		throw new Error("Durable writer unavailable", { cause: error });
	}
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		db.close();
	};
}
