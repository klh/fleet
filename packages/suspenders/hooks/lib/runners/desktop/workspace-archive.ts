import { z } from "zod";

export const WorkspaceArchiveLimitsSchema = z.strictObject({
	maxEncodedBytes: z.number().int().positive(),
	/** Total payload bytes across all regular files, not a per-file buffer. */
	maxFileBytes: z.number().int().nonnegative(),
	maxEntries: z.number().int().nonnegative(),
});
export type WorkspaceArchiveLimits = z.infer<
	typeof WorkspaceArchiveLimitsSchema
>;
export interface WorkspaceArchiveHeader {
	path: string;
	type: "file" | "directory";
	size: number;
}
export type WorkspaceArchiveEvent =
	| { kind: "header"; header: WorkspaceArchiveHeader; bytes: Uint8Array }
	| { kind: "body" | "padding" | "end"; bytes: Uint8Array };
export class WorkspaceArchiveError extends Error {}

class ArchiveReader {
	private readonly iterator: AsyncIterator<Uint8Array>;
	private pending: Uint8Array = new Uint8Array(0);
	private offset = 0;
	private done = false;
	private encoded = 0;
	constructor(
		source: AsyncIterable<Uint8Array>,
		private cap: number,
	) {
		this.iterator = source[Symbol.asyncIterator]();
	}
	async take(max: number): Promise<Uint8Array | null> {
		while (this.offset === this.pending.length) {
			if (this.done) return null;
			const next = await this.iterator.next();
			if (next.done) {
				this.done = true;
				return null;
			}
			if (next.value.byteLength > this.cap - this.encoded)
				throw new WorkspaceArchiveError("archive: encoded byte limit");
			this.encoded += next.value.byteLength;
			this.pending = next.value;
			this.offset = 0;
		}
		const bytes = this.pending.subarray(
			this.offset,
			this.offset + Math.min(max, 65536),
		);
		this.offset += bytes.length;
		return bytes;
	}
	async close() {
		this.pending = new Uint8Array(0);
		if (!this.done) {
			this.done = true;
			await this.iterator.return?.();
		}
	}
	async block(allowEOF = false): Promise<Uint8Array | null> {
		const block = new Uint8Array(512);
		let filled = 0;
		while (filled < block.length) {
			const part = await this.take(block.length - filled);
			if (!part) {
				if (allowEOF && filled === 0) return null;
				throw new WorkspaceArchiveError("archive: truncated block or EOF");
			}
			block.set(part, filled);
			filled += part.length;
		}
		return block;
	}
}
function parseHeader(block: Uint8Array): WorkspaceArchiveHeader {
	const octal = (field: Uint8Array) => {
		const text = String.fromCharCode(...field);
		if (!/^ *[0-7]+[\0 ]*$/.test(text))
			throw new WorkspaceArchiveError("archive: invalid octal field");
		const value = Number.parseInt(text, 8);
		if (!Number.isSafeInteger(value) || value < 0)
			throw new WorkspaceArchiveError("archive: unsafe size");
		return value;
	};
	let sum = 0;
	for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
	if (sum !== octal(block.subarray(148, 156)))
		throw new WorkspaceArchiveError("archive: checksum mismatch");
	if (
		!new TextDecoder()
			.decode(block.subarray(257, 265))
			.startsWith("ustar\0" + "00")
	)
		throw new WorkspaceArchiveError("archive: unsupported USTAR magic/version");
	const text = (start: number, length: number) => {
		const field = block.subarray(start, start + length),
			zero = field.indexOf(0);
		if (zero >= 0 && field.subarray(zero).some((byte) => byte !== 0))
			throw new WorkspaceArchiveError("archive: malformed name field");
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				zero < 0 ? field : field.subarray(0, zero),
			);
		} catch {
			throw new WorkspaceArchiveError("archive: invalid UTF-8 path");
		}
	};
	const flag = block[156];
	if (flag !== 0 && flag !== 48 && flag !== 53)
		throw new WorkspaceArchiveError(
			"archive: links and extension entry types refused",
		);
	const name = text(0, 100),
		prefix = text(345, 155),
		size = octal(block.subarray(124, 136));
	if (!name) throw new WorkspaceArchiveError("archive: empty name");
	if (flag === 53 && size !== 0)
		throw new WorkspaceArchiveError("archive: directory has payload");
	return {
		path: prefix ? `${prefix}/${name}` : name,
		type: flag === 53 ? "directory" : "file",
		size,
	};
}
class ArchivePaths {
	private explicit = new Map<string, "file" | "directory">();
	private parents = new Set<string>();
	accept(header: WorkspaceArchiveHeader, first: boolean) {
		let path = header.path;
		if (path === "./" && header.type === "directory") {
			if (!first)
				throw new WorkspaceArchiveError("archive: root must be first");
			header.path = "";
			this.explicit.set("", "directory");
			return;
		}
		if (path.startsWith("./")) path = path.slice(2);
		if (header.type === "directory" && path.endsWith("/"))
			path = path.slice(0, -1);
		const segments = path.split("/");
		if (
			segments.some(
				(segment) => segment === "" || segment === "." || segment === "..",
			)
		)
			throw new WorkspaceArchiveError("archive: unsafe path");
		if (this.explicit.has(path))
			throw new WorkspaceArchiveError("archive: duplicate path");
		if (header.type === "file" && this.parents.has(path))
			throw new WorkspaceArchiveError("archive: path conflict");
		for (let index = 1; index < segments.length; index++) {
			const parent = segments.slice(0, index).join("/");
			if (this.explicit.get(parent) === "file")
				throw new WorkspaceArchiveError("archive: parent file conflict");
			this.parents.add(parent);
		}
		this.explicit.set(path, header.type);
		header.path = path;
	}
}
/** Validate to completion before publication; yielded prefixes alone are not approval.
 * Concatenating event.bytes preserves every raw archive byte. Consumers must not
 * mutate those views. Upstream buffers may exceed 64KiB: we retain one readonly
 * view/cursor, never fetch the next until consumed, copy only 512-byte blocks,
 * and emit body views of at most 64KiB. No archive/file-sized allocation occurs.
 * Paths are POSIX guest paths; backslash is literal, and only first ./ directory
 * maps to the empty root path. No host extraction or lifecycle authority here.
 */
export async function* validateWorkspaceArchive(
	source: AsyncIterable<Uint8Array>,
	limits: WorkspaceArchiveLimits,
): AsyncGenerator<WorkspaceArchiveEvent> {
	const caps = WorkspaceArchiveLimitsSchema.parse(limits);
	const reader = new ArchiveReader(source, caps.maxEncodedBytes);
	let entries = 0,
		fileBytes = 0;
	const paths = new ArchivePaths();
	try {
		for (;;) {
			const block = await reader.block();
			if (!block) throw new WorkspaceArchiveError("archive: missing EOF");
			if (block.every((byte) => byte === 0)) {
				const second = await reader.block();
				if (!second || second.some((byte) => byte !== 0))
					throw new WorkspaceArchiveError(
						"archive: two zero EOF blocks required",
					);
				yield { kind: "end", bytes: block };
				yield { kind: "end", bytes: second };
				for (;;) {
					const tail = await reader.block(true);
					if (!tail) return;
					if (tail.some((byte) => byte !== 0))
						throw new WorkspaceArchiveError("archive: nonzero trailing block");
					yield { kind: "end", bytes: tail };
				}
			}
			const header = parseHeader(block);
			if (++entries > caps.maxEntries)
				throw new WorkspaceArchiveError("archive: entry limit");
			paths.accept(header, entries === 1);
			if (header.size > caps.maxFileBytes - fileBytes)
				throw new WorkspaceArchiveError("archive: file byte limit");
			fileBytes += header.size;
			yield { kind: "header", header, bytes: block };
			let remaining = header.size;
			while (remaining > 0) {
				const bytes = await reader.take(remaining);
				if (!bytes) throw new WorkspaceArchiveError("archive: truncated body");
				remaining -= bytes.length;
				yield { kind: "body", bytes };
			}
			let padding = (512 - (header.size % 512)) % 512;
			while (padding > 0) {
				const bytes = await reader.take(padding);
				if (!bytes)
					throw new WorkspaceArchiveError("archive: truncated padding");
				if (bytes.some((byte) => byte !== 0))
					throw new WorkspaceArchiveError("archive: nonzero padding");
				padding -= bytes.length;
				yield { kind: "padding", bytes };
			}
		}
	} finally {
		await reader.close();
	}
}
