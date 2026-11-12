import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export class ConnectionConfigError extends Error {
	readonly code = "settings.connection.invalid";
	constructor() {
		super("Invalid private connection configuration");
	}
}

export const CONNECTION_DOCUMENT_MAX_BYTES = 1048576;

/** A single owned descriptor binds posture, byte cap and the actual read. */
export function readConnectionFile(
	filename: string,
	absentAllowed = false,
	maxBytes = CONNECTION_DOCUMENT_MAX_BYTES,
): string | undefined {
	let fd: number;
	try {
		fd = openSync(
			filename,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (
			absentAllowed &&
			error instanceof Error &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return undefined;
		throw new ConnectionConfigError();
	}
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > maxBytes
		)
			throw new ConnectionConfigError();
		const bytes = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length > maxBytes) throw new ConnectionConfigError();
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, length),
		);
	} catch {
		throw new ConnectionConfigError();
	} finally {
		closeSync(fd);
	}
}

export function parseConnectionJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new ConnectionConfigError();
	}
}
