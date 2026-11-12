// Shared authenticated-catalog plumbing: private key files and size-capped
// JSON bodies. Errors carry fixed text only — never a key, header or body.
import { lstatSync, readFileSync } from "node:fs";

const MAX_CATALOG_BYTES = 1024 * 1024;

/** One response under the same operation deadline, even for injected fetchers. */
export async function catalogResponse(
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	fetcher: typeof fetch,
): Promise<Response> {
	if (signal.aborted) throw new Error("catalog timed out");
	let onAbort = () => {};
	const deadline = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("catalog timed out"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([deadline, fetcher(url, { ...init, signal })]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

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
	signal?: AbortSignal,
	budget = { remaining: MAX_CATALOG_BYTES, limit: MAX_CATALOG_BYTES },
): Promise<unknown> {
	if (!response.body) throw new Error(`${label} HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let onAbort = () => {};
	const deadline = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error(`${label} timed out`));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), deadline]);
			if (done) break;
			bytes += value.byteLength;
			budget.remaining -= value.byteLength;
			if (budget.remaining < 0)
				throw new Error(`${label} exceeds ${budget.limit / 1024 / 1024} MiB`);
			chunks.push(value);
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		void reader.cancel().catch(() => {});
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
