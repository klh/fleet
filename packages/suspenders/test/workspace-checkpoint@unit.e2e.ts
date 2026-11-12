import { chmod, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	openWorkspaceCheckpoint,
	saveWorkspaceCheckpoint,
} from "../hooks/lib/runners/desktop/workspace-checkpoint.ts";

const binding = () => ({
	job: {
		spec: {
			version: 1,
			runId: crypto.randomUUID(),
			owner: "fixture",
			generation: 1,
			kind: "coding",
			seedDigest: "a".repeat(64),
			policyDigest: "b".repeat(64),
			provider: "fixture",
			model: "fixture",
		},
		runtime: "pi-durable@1.5.0",
		host: "fixture-host",
	},
	image: `fixture/tool@sha256:${"c".repeat(64)}`,
	deadlineAt: Date.now() + 60_000,
	leaseEpoch: 3,
	conversationId: "conversation-2",
});
async function* bytes(text: string) {
	yield new TextEncoder().encode(text);
}

test("save refuses an unprovisioned root @unit", async () => {
	const world = scratchWorld();
	try {
		await expect(
			saveWorkspaceCheckpoint({
				root: join(world.home, "unprovisioned"),
				binding: binding(),
				source: bytes("data"),
				maxBytes: 100,
			}),
		).rejects.toThrow("pre-provisioned");
		expect(await readdir(world.home)).toEqual([]);
	} finally {
		world.clean();
	}
});

test("serialized metadata must fit the reader limit before publication @unit", async () => {
	const world = scratchWorld(),
		expected = binding();
	try {
		const huge = {
			...expected,
			job: { ...expected.job, host: "h".repeat(70_000) },
		};
		await expect(
			saveWorkspaceCheckpoint({
				root: world.home,
				binding: huge,
				source: bytes("data"),
				maxBytes: 100,
			}),
		).rejects.toThrow("metadata limit");
		expect(await readdir(world.home)).toEqual([]);
	} finally {
		world.clean();
	}
});

test("opening an unpublished checkpoint never creates recovery state @unit", async () => {
	const world = scratchWorld();
	try {
		const before = await readdir(world.home);
		await expect(
			openWorkspaceCheckpoint({
				root: world.home,
				id: crypto.randomUUID(),
				expected: binding(),
				maxBytes: 100,
			}),
		).rejects.toThrow();
		expect(await readdir(world.home)).toEqual(before);
	} finally {
		world.clean();
	}
});

test("cap crossing and interrupted streams cannot publish a checkpoint @unit", async () => {
	const world = scratchWorld();
	let closed = false;
	async function* tooLarge() {
		try {
			yield new Uint8Array(64);
			yield new Uint8Array(64);
		} finally {
			closed = true;
		}
	}
	async function* interrupted() {
		yield new Uint8Array(8);
		throw new Error("source interrupted");
	}
	try {
		const before = await readdir(world.home);
		await expect(
			saveWorkspaceCheckpoint({
				root: world.home,
				binding: binding(),
				source: tooLarge(),
				maxBytes: 100,
			}),
		).rejects.toThrow("byte limit");
		expect(closed).toBe(true);
		expect(await readdir(world.home)).toEqual(before);
		await expect(
			saveWorkspaceCheckpoint({
				root: world.home,
				binding: binding(),
				source: interrupted(),
				maxBytes: 100,
			}),
		).rejects.toThrow("source interrupted");
		expect(await readdir(world.home)).toEqual(before);
	} finally {
		world.clean();
	}
});

test("changed identity and expired original deadline cannot restore @unit", async () => {
	const world = scratchWorld(),
		expected = binding();
	try {
		const saved = await saveWorkspaceCheckpoint({
			root: world.home,
			binding: expected,
			source: bytes("data"),
			maxBytes: 100,
		});
		for (const changed of [
			{ ...expected, leaseEpoch: 4 },
			{ ...expected, conversationId: "other" },
			{ ...expected, deadlineAt: expected.deadlineAt + 1 },
			{ ...expected, image: `fixture/tool@sha256:${"d".repeat(64)}` },
			{ ...expected, job: { ...expected.job, host: "other-host" } },
			{
				...expected,
				job: {
					...expected.job,
					spec: { ...expected.job.spec, seedDigest: "d".repeat(64) },
				},
			},
		]) {
			await expect(
				openWorkspaceCheckpoint({
					root: world.home,
					id: saved.id,
					expected: changed,
					maxBytes: 100,
				}),
			).rejects.toThrow("binding mismatch");
		}
		const expired = { ...expected, deadlineAt: Date.now() - 1 };
		await writeFile(
			join(world.home, saved.id, "manifest.json"),
			JSON.stringify({ ...saved, binding: expired }),
		);
		await expect(
			openWorkspaceCheckpoint({
				root: world.home,
				id: saved.id,
				expected: expired,
				maxBytes: 100,
			}),
		).rejects.toThrow("original deadline expired");
	} finally {
		world.clean();
	}
});

test("corrupted, public or symlinked archive never opens for restore @unit", async () => {
	const world = scratchWorld(),
		expected = binding();
	try {
		const saved = await saveWorkspaceCheckpoint({
			root: world.home,
			binding: expected,
			source: bytes("original bytes"),
			maxBytes: 100,
		});
		const archive = join(world.home, saved.id, "workspace.tar");
		expect(await readFile(archive, "utf8")).toBe("original bytes");
		await writeFile(archive, "tampered bytes");
		await expect(
			openWorkspaceCheckpoint({
				root: world.home,
				id: saved.id,
				expected,
				maxBytes: 100,
			}),
		).rejects.toThrow("integrity");
		await writeFile(archive, "original bytes");
		await chmod(archive, 0o644);
		await expect(
			openWorkspaceCheckpoint({
				root: world.home,
				id: saved.id,
				expected,
				maxBytes: 100,
			}),
		).rejects.toThrow("private");
		const id = crypto.randomUUID();
		await symlink(join(world.home, saved.id), join(world.home, id));
		await expect(
			openWorkspaceCheckpoint({
				root: world.home,
				id,
				expected,
				maxBytes: 100,
			}),
		).rejects.toThrow("symlink");
	} finally {
		world.clean();
	}
});

test("checkpoint binds private streamed bytes to original execution identity @unit", async () => {
	const world = scratchWorld(),
		expected = binding();
	try {
		const saved = await saveWorkspaceCheckpoint({
			root: world.home,
			binding: expected,
			source: bytes("opaque archive bytes"),
			maxBytes: 100,
		});
		const opened = await openWorkspaceCheckpoint({
			root: world.home,
			id: saved.id,
			expected,
			maxBytes: 100,
		});
		try {
			expect(await opened.file.readFile("utf8")).toBe("opaque archive bytes");
			expect(opened.manifest.binding).toEqual(expected);
		} finally {
			await opened.file.close();
		}
	} finally {
		world.clean();
	}
});
