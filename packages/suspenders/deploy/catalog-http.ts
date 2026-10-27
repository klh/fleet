// Shared authenticated-catalog plumbing: private key files and size-capped
// JSON bodies. Errors carry fixed text only — never a key, header or body.
import { lstatSync, readFileSync } from "node:fs";

const MAX_CATALOG_BYTES = 1024 * 1024;

/** The key value stays with the caller; a symlink or group/other bit refuses. */
export function readPrivateKey(keyFile: string, label: string): string {
	const stat = lstatSync(keyFile);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
		throw new Error(`${label} key file must be a private regular file (0600)`);
	const key = readFileSync(keyFile, "utf8").trim();
	if (!key) throw new Error(`${label} key file is empty`);
	return key;
}

/** Streams the body and stops at 1 MiB instead of buffering a hostile one. */
export async function readBoundedJson(
	response: Response,
	label: string,
): Promise<unknown> {
	if (!response.body) throw new Error(`${label} HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_CATALOG_BYTES) throw new Error(`${label} exceeds 1 MiB`);
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}
