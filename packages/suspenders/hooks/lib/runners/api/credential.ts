import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Read the same descriptor that was checked; refuse symlink and permissive keys. */
export function readRunnerCredential(path: string): string {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const stat = fstatSync(descriptor);
		if (
			!stat.isFile() ||
			stat.size > 4096 ||
			(stat.mode & 0o077) !== 0 ||
			(process.getuid && stat.uid !== process.getuid())
		)
			throw new Error("invalid key file");
		const buffer = Buffer.alloc(4097);
		const count = readSync(descriptor, buffer, 0, buffer.length, 0);
		if (count > 4096) throw new Error("invalid key file");
		const key = buffer.subarray(0, count).toString("utf8").trim();
		if (!/^[A-Za-z0-9._~-]{1,4096}$/.test(key)) throw new Error("invalid key");
		return key;
	} catch {
		throw new Error("runner.private_credential_required");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}
