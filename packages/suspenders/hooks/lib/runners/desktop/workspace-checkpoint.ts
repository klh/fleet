import { z } from "zod";
import { constants } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { JobManifestSchema } from "../durable/contracts.ts";
import { IMAGE_PIN } from "./seed.ts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existingEntry, privateDirectory } from "../durable/private-paths.ts";

/** Immutable execution identity, never model-supplied or a new admission grant. */
export const WorkspaceCheckpointBindingSchema = z.strictObject({
	job: JobManifestSchema,
	image: z.string().regex(IMAGE_PIN),
	deadlineAt: z.number().int().positive(),
	leaseEpoch: z.number().int().positive(),
	conversationId: z.string().min(1).max(256),
});
export const WorkspaceCheckpointSchema = z.strictObject({
	version: z.literal(1),
	id: z.uuid(),
	binding: WorkspaceCheckpointBindingSchema,
	archive: z.strictObject({
		file: z.literal("workspace.tar"),
		bytes: z.number().int().nonnegative(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	}),
});
export type WorkspaceCheckpointBinding = z.output<
	typeof WorkspaceCheckpointBindingSchema
>;
export type WorkspaceCheckpoint = z.output<typeof WorkspaceCheckpointSchema>;
const LimitSchema = z
	.number()
	.int()
	.positive()
	.max(1024 * 1024 * 1024);

/** Open once with nofollow; validation and replay share this descriptor. */
async function privateFile(
	path: string,
	maxBytes: number,
): Promise<FileHandle> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			!process.getuid ||
			info.uid !== process.getuid() ||
			(info.mode & 0o777) !== 0o600
		)
			throw new Error("checkpoint: archive must be private to its POSIX owner");
		if (info.size > LimitSchema.parse(maxBytes))
			throw new Error("checkpoint: byte limit");
		return file;
	} catch (error) {
		await file.close();
		throw error;
	}
}

export async function openWorkspaceCheckpoint(input: unknown): Promise<{
	file: FileHandle;
	manifest: WorkspaceCheckpoint;
}> {
	const opts = z
		.strictObject({
			root: z.string().min(1),
			id: z.uuid(),
			expected: WorkspaceCheckpointBindingSchema,
			maxBytes: LimitSchema,
		})
		.parse(input);
	const directory = join(opts.root, opts.id);
	if (!(await existingEntry(opts.root)) || !(await existingEntry(directory)))
		throw new Error("checkpoint: unpublished or missing checkpoint");
	await privateDirectory(opts.root);
	await privateDirectory(directory);
	const metadata = await privateFile(join(directory, "manifest.json"), 65536);
	let manifest: WorkspaceCheckpoint;
	try {
		manifest = WorkspaceCheckpointSchema.parse(
			JSON.parse(await metadata.readFile("utf8")),
		);
	} finally {
		await metadata.close();
	}
	if (
		manifest.id !== opts.id ||
		JSON.stringify(manifest.binding) !== JSON.stringify(opts.expected)
	)
		throw new Error("checkpoint: execution binding mismatch");
	if (manifest.binding.deadlineAt <= Date.now())
		throw new Error("checkpoint: original deadline expired");
	const file = await privateFile(
		join(directory, manifest.archive.file),
		opts.maxBytes,
	);
	try {
		const hash = createHash("sha256");
		let bytes = 0;
		for await (const chunk of file.createReadStream({
			start: 0,
			autoClose: false,
		})) {
			bytes += chunk.length;
			if (bytes > opts.maxBytes) throw new Error("checkpoint: byte limit");
			hash.update(chunk);
		}
		if (
			bytes !== manifest.archive.bytes ||
			hash.digest("hex") !== manifest.archive.sha256
		)
			throw new Error("checkpoint: archive integrity mismatch");
		return { file, manifest };
	} catch (error) {
		await file.close();
		throw error;
	}
}

export async function saveWorkspaceCheckpoint(options: {
	root: string;
	binding: unknown;
	source: AsyncIterable<Uint8Array>;
	maxBytes: number;
}): Promise<WorkspaceCheckpoint> {
	const root = z.string().min(1).parse(options.root),
		binding = WorkspaceCheckpointBindingSchema.parse(options.binding);
	const limit = LimitSchema.parse(options.maxBytes),
		id = crypto.randomUUID(),
		directory = join(root, id);
	if (binding.deadlineAt <= Date.now())
		throw new Error("checkpoint: original deadline expired");
	if (!(await existingEntry(root)))
		throw new Error("checkpoint: storage root must be pre-provisioned durably");
	await privateDirectory(root);
	await privateDirectory(directory);
	try {
		const file = await open(
			join(directory, "workspace.tar"),
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		const hash = createHash("sha256");
		let bytes = 0;
		try {
			for await (const chunk of options.source) {
				bytes += chunk.byteLength;
				if (bytes > limit) throw new Error("checkpoint: byte limit");
				await file.writeFile(chunk);
				hash.update(chunk);
			}
			await file.sync();
		} finally {
			await file.close();
		}
		const manifest = WorkspaceCheckpointSchema.parse({
			version: 1,
			id,
			binding,
			archive: { file: "workspace.tar", bytes, sha256: hash.digest("hex") },
		});
		const metadata = `${JSON.stringify(manifest)}\n`;
		if (Buffer.byteLength(metadata) > 65536)
			throw new Error("checkpoint: metadata limit");
		atomicWrite0600(join(directory, "manifest.json"), metadata);
		for (const path of [join(directory, "manifest.json"), directory, root]) {
			const entry = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				await entry.sync();
			} finally {
				await entry.close();
			}
		}
		return manifest;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
