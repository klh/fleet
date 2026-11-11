import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { JobManifestSchema } from "./contracts.ts";

export const JournalAnchorSchema = z.strictObject({
	version: z.literal(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	bytes: z.number().int().positive(),
	files: z.number().int().positive(),
});
export type JournalAnchor = z.output<typeof JournalAnchorSchema>;
const MAX_BYTES = 128 * 1024 * 1024,
	MAX_FILES = 10_000;

/** A closed HOST journal remains HOST-owned. Checkpoints bind its exact
 * bytes, not merely a conversation ID that an empty journal could recreate. */
export async function fingerprintClosedJournal(root: string, runId: string) {
	const directory = join(root, runId),
		state = join(directory, "state");
	await existingJournalIdentity(root, runId);
	const privateEntry = async (path: string, kind: "file" | "directory") => {
		const info = await lstat(path);
		if (
			info.uid !== process.getuid?.() ||
			(info.mode & (kind === "file" ? 0o022 : 0o077)) !== 0 ||
			(kind === "file"
				? !info.isFile() || info.nlink !== 1
				: !info.isDirectory())
		)
			throw new Error(
				"runner: HOST journal must be existing private regular state",
			);
		return info;
	};
	await privateEntry(directory, "directory");
	await privateEntry(state, "directory");
	await privateEntry(join(directory, "manifest.json"), "file");
	const manifestFile = await open(
		join(directory, "manifest.json"),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	let manifest: z.output<typeof JobManifestSchema>, manifestBytes: Buffer;
	try {
		if ((await manifestFile.stat()).size > 65_536)
			throw new Error("runner: HOST manifest byte limit");
		manifestBytes = await manifestFile.readFile();
		manifest = JobManifestSchema.parse(
			JSON.parse(manifestBytes.toString("utf8")),
		);
	} finally {
		await manifestFile.close();
	}
	const hash = createHash("sha256").update(manifestBytes);
	let bytes = 0,
		files = 0;
	const visit = async (path: string, prefix: string): Promise<void> => {
		for (const name of (await readdir(path)).sort()) {
			const absolute = join(path, name),
				relative = prefix + name;
			const info = await lstat(absolute);
			if (info.isDirectory()) {
				await privateEntry(absolute, "directory");
				await visit(absolute, `${relative}/`);
				continue;
			}
			await privateEntry(absolute, "file");
			files++;
			if (files > MAX_FILES || bytes + info.size > MAX_BYTES)
				throw new Error("runner: HOST journal bound exceeded");
			const file = await open(
				absolute,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				hash.update(`${JSON.stringify([relative, info.size])}\n`);
				let actual = 0;
				for await (const chunk of file.createReadStream({
					start: 0,
					autoClose: false,
				})) {
					actual += chunk.length;
					bytes += chunk.length;
					if (bytes > MAX_BYTES)
						throw new Error("runner: HOST journal bound exceeded");
					hash.update(chunk);
				}
				if (actual !== info.size)
					throw new Error("runner: HOST journal changed while sealing");
			} finally {
				await file.close();
			}
		}
	};
	await visit(state, "");
	if (bytes === 0 || files === 0)
		throw new Error("runner: HOST journal history missing");
	return {
		manifest,
		anchor: JournalAnchorSchema.parse({
			version: 1,
			sha256: hash.digest("hex"),
			bytes,
			files,
		}),
	};
}

/** Same-HOST file identity binds the authoritative append-only main journal.
 * Its presence alone is insufficient: existingOnly also looks up SDK root. */
export const JournalIdentitySchema = z.strictObject({
	dev: z.number().int().nonnegative().safe(),
	ino: z.number().int().positive().safe(),
});
export type JournalIdentity = z.output<typeof JournalIdentitySchema>;
export async function existingJournalIdentity(
	root: string,
	runId: string,
): Promise<JournalIdentity> {
	const directory = join(root, runId),
		state = join(directory, "state");
	for (const path of [directory, state]) {
		const info = await lstat(path);
		if (
			!info.isDirectory() ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o077) !== 0
		)
			throw new Error("runner: existing private HOST journal required");
	}
	const file = await open(
		join(state, "main.jsonl"),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			info.size === 0 ||
			info.nlink !== 1 ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o022) !== 0
		)
			throw new Error(
				"runner: authoritative HOST main journal missing or empty",
			);
		return JournalIdentitySchema.parse({ dev: info.dev, ino: info.ino });
	} finally {
		await file.close();
	}
}
