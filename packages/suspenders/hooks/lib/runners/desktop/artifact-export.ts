// artifact-export.ts — W2869.3: bounded nofollow artifact export. The
// workspace rides `docker exec <id> tar --format=ustar --blocking-factor=1
// -C /workspace -cf - .` — root #117946: docker cp does NOT see tmpfs
// content (paused or not), the exec route is the only trusted export —
// as a ustar byte stream walked at HEADER granularity: each entry size is
// read from the tar header before its data crosses, any entry crossing the
// cap aborts the export mid-stream (proc killed, dest tree discarded), and
// ANY link/PAX/GNU-longname entry refuses the whole export (nofollow —
// links are never extracted, never skipped). Raw-byte header parsing:
// arbitrary filenames (newlines included) ride tar framing, never a text
// protocol.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StreamRun } from "./spawn.ts";

/** Thrown for every refusal: links, unsafe paths, cap crossings, corrupt
 *  tar framing, truncation. The caller discards the dest tree. */
export class ArtifactRefusalError extends Error {}

const BLOCK = 512;
const SIZE_OFF = 124;
const SIZE_LEN = 12;
const TYPE_OFF = 156;
const PREFIX_OFF = 345;
const PREFIX_LEN = 155;
const decoder = new TextDecoder("utf-8");

const cstring = (b: Uint8Array): string => {
	const end = b.indexOf(0);
	return decoder.decode(end === -1 ? b : b.subarray(0, end));
};

const octalOf = (b: Uint8Array): number => {
	const text = cstring(b).trim();
	const n = Number.parseInt(text, 8);
	if (!Number.isFinite(n)) {
		throw new ArtifactRefusalError(
			`artifact-export: corrupt tar size field ${JSON.stringify(text)}`,
		);
	}
	return n;
};

interface TarHeader {
	path: string;
	size: number;
	type: string;
}

export const parseTarHeader = (block: Uint8Array): TarHeader => {
	const name = cstring(block.subarray(0, 100));
	const prefix = cstring(block.subarray(PREFIX_OFF, PREFIX_OFF + PREFIX_LEN));
	const raw = String.fromCharCode(block[TYPE_OFF]);
	return {
		path: prefix.length > 0 ? `${prefix}/${name}` : name,
		size: octalOf(block.subarray(SIZE_OFF, SIZE_OFF + SIZE_LEN)),
		type: raw === "\0" ? "0" : raw,
	};
};

const isZeroBlock = (b: Uint8Array): boolean => {
	for (const byte of b) {
		if (byte !== 0) return false;
	}
	return true;
};

const safeArtifactPath = (path: string): void => {
	if (path.length === 0) {
		throw new ArtifactRefusalError("artifact-export: empty entry path");
	}
	const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	if (trimmed.startsWith("/") || trimmed.length === 0) {
		throw new ArtifactRefusalError(
			`artifact-export: absolute entry path refused: ${JSON.stringify(path)}`,
		);
	}
	for (const seg of trimmed.split("/")) {
		if (seg === "" || seg === "." || seg === "..") {
			throw new ArtifactRefusalError(
				`artifact-export: unsafe entry path refused: ${JSON.stringify(path)}`,
			);
		}
	}
};

/** Buffered exact-read over the docker cp byte stream. Pending chunks are
 *  consumed in place; nothing beyond the requested bytes is held. */
class StreamReader {
	private pending: Uint8Array[] = [];
	private filled = 0;
	private done = false;
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

	constructor(stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader();
	}

	close(): void {
		void this.reader.cancel();
	}

	private async fill(): Promise<boolean> {
		if (this.done) return false;
		const { value, done } = await this.reader.read();
		if (done) {
			this.done = true;
			return false;
		}
		this.pending.push(value);
		this.filled += value.byteLength;
		return true;
	}

	private async ensure(n: number): Promise<void> {
		while (this.filled < n) {
			if (!(await this.fill())) {
				throw new ArtifactRefusalError(
					"artifact-export: truncated tar stream",
				);
			}
		}
	}

	async readExact(n: number): Promise<Uint8Array> {
		await this.ensure(n);
		const out = new Uint8Array(n);
		let cursor = 0;
		while (cursor < n) {
			const head = this.pending[0];
			const take = Math.min(head.byteLength, n - cursor);
			out.set(head.subarray(0, take), cursor);
			cursor += take;
			if (take === head.byteLength) {
				this.pending.shift();
			} else {
				this.pending[0] = head.subarray(take);
			}
			this.filled -= take;
		}
		return out;
	}
}

export interface ExportOptions {
	dockerBin: string;
	/** Name or id of the run container — exec-tar export needs no freeze. */
	containerRef: string;
	destDir: string;
	capBytes: number;
	run: (argv: string[]) => Promise<StreamRun>;
}

export interface ExportTally {
	files: number;
	bytes: number;
}

const checkEntry = (entry: TarHeader): number => {
	if (entry.type !== "0" && entry.type !== "5") {
		throw new ArtifactRefusalError(
			`artifact-export: non-plain tar entry type ${JSON.stringify(entry.type)} for ${JSON.stringify(entry.path)} — links/PAX refused (nofollow)`,
		);
	}
	safeArtifactPath(entry.path);
	return entry.size % BLOCK === 0 ? 0 : BLOCK - (entry.size % BLOCK);
};

const writeEntry = async (
	reader: StreamReader,
	entry: TarHeader,
	opts: ExportOptions,
	tally: { files: number; bytes: number },
): Promise<void> => {
	if (entry.type === "5") {
		if (entry.size > 0) await reader.readExact(entry.size);
		await mkdir(join(opts.destDir, entry.path), { recursive: true });
		return;
	}
	if (tally.bytes + entry.size > opts.capBytes) {
		throw new ArtifactRefusalError(
			`artifact-export: entry crosses cap (${tally.bytes} + ${entry.size} > ${opts.capBytes}) — export aborted mid-stream`,
		);
	}
	const abs = join(opts.destDir, entry.path);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, await reader.readExact(entry.size));
	tally.bytes += entry.size;
	tally.files += 1;
};

/** Walk the paused container's workspace as a ustar stream: header-first
 *  sizing, mid-stream cap abort, nofollow refusal, traversal refusal. */
export const exportArtifacts = async (
	opts: ExportOptions,
): Promise<ExportTally> => {
	await mkdir(opts.destDir, { recursive: true });
	// Root #117946: the ONLY export route that sees tmpfs content — exec-tar
	// over fixed trusted argv, no shell, no freeze.
	const proc = await opts.run([
		opts.dockerBin,
		"exec",
		opts.containerRef,
		"tar",
		"--format=ustar",
		"--blocking-factor=1",
		"-C", "/workspace",
		"-cf", "-",
		".",
	]);
	const reader = new StreamReader(proc.stream);
	const tally: ExportTally = { files: 0, bytes: 0 };
	try {
		for (;;) {
			const block = await reader.readExact(BLOCK);
			if (isZeroBlock(block)) break;
			const entry = parseTarHeader(block);
			const pad = checkEntry(entry);
			await writeEntry(reader, entry, opts, tally);
			if (pad > 0) await reader.readExact(pad);
		}
	} catch (err) {
		proc.kill();
		reader.close();
		await rm(opts.destDir, { recursive: true, force: true });
		throw err;
	}
	// tar's exit code is part of the receipt — a non-zero tar exit after a
	// clean stream is a warn-only failure: refuse and discard the dest tree.
	const code = await proc.exit;
	if (code !== 0) {
		proc.kill();
		reader.close();
		await rm(opts.destDir, { recursive: true, force: true });
		throw new ArtifactRefusalError(
			`artifact-export: tar exited ${code} — export refused`,
		);
	}
	return tally;
};
