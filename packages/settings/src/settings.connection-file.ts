import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export class ConnectionConfigError extends Error {
	readonly code = "settings.connection.invalid";
	constructor() {
		super("Invalid private connection configuration");
	}
}

export const CONNECTION_DOCUMENT_MAX_BYTES = 1048576;

/** One descriptor binds bounded bytes and their observed private-file posture. */
export function readBoundedConfigFile(
	filename: string,
	absentAllowed = false,
	maxBytes = CONNECTION_DOCUMENT_MAX_BYTES,
): { text: string; privateFile: boolean } | undefined {
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
		if (!stat.isFile() || stat.size > maxBytes)
			throw new ConnectionConfigError();
		const bytes = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length > maxBytes) throw new ConnectionConfigError();
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, length),
			),
			privateFile:
				stat.nlink === 1 &&
				stat.uid === process.getuid?.() &&
				(stat.mode & 0o777) === 0o600,
		};
	} catch {
		throw new ConnectionConfigError();
	} finally {
		closeSync(fd);
	}
}

/** Credential files retain their existing private-only reader contract. */
export function readConnectionFile(
	filename: string,
	absentAllowed = false,
	maxBytes = CONNECTION_DOCUMENT_MAX_BYTES,
): string | undefined {
	const snapshot = readBoundedConfigFile(filename, absentAllowed, maxBytes);
	if (snapshot && !snapshot.privateFile) throw new ConnectionConfigError();
	return snapshot?.text;
}

export function parseConnectionJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new ConnectionConfigError();
	}
}
