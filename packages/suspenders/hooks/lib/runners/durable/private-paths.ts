import { lstat, mkdir } from "node:fs/promises";

export async function existingEntry(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

/** Private POSIX job storage; an existing user path is validated, never chmodded. */
export async function privateDirectory(path: string): Promise<void> {
	let info = await existingEntry(path);
	if (!info) {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
		}
		info = await lstat(path);
	}
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error("Durable private directory must not be a symlink or file");
	if (
		!process.getuid ||
		info.uid !== process.getuid() ||
		(info.mode & 0o077) !== 0
	)
		throw new Error("Durable job directory must be private to its POSIX owner");
}
