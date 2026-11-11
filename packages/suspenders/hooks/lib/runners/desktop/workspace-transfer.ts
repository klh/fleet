import type { FileHandle } from "node:fs/promises";
import { validateWorkspaceArchive } from "./workspace-archive.ts";
import {
	saveWorkspaceCheckpoint,
	type WorkspaceCheckpointBinding,
} from "./workspace-checkpoint.ts";
import { runArgvStream } from "./spawn.ts";
import type { DesktopExecutorDeps, ExecutorRecord } from "./docker-executor.ts";

const limitsFor = (maxBytes: number) => ({
	maxEncodedBytes: maxBytes,
	maxFileBytes: maxBytes,
	maxEntries: 10_000,
});
const timeoutFor = (deadlineAt: number) => {
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) throw new Error("checkpoint: original deadline expired");
	return Math.min(60_000, remaining);
};

/** Tar exit is part of the source's completion, so manifest publication
 * cannot race a failed producer after stdout EOF. */
export async function captureWorkspace(options: {
	deps: DesktopExecutorDeps;
	record: ExecutorRecord;
	root: string;
	binding: WorkspaceCheckpointBinding;
	maxBytes: number;
	operationDeadlineAt?: number;
}) {
	const { deps, record, binding, maxBytes } = options;
	const timeoutMs = timeoutFor(
		Math.min(
			binding.deadlineAt,
			options.operationDeadlineAt ?? binding.deadlineAt,
		),
	);
	const argv = [
		deps.dockerBin ?? "docker",
		"exec",
		record.containerId,
		"tar",
		"--format=ustar",
		"--blocking-factor=1",
		"-C",
		"/workspace",
		"-cf",
		"-",
		".",
	];
	const child = await (
		deps.runDockerStream ??
		((args) => runArgvStream(deps.dockerArgv ? deps.dockerArgv(args) : args))
	)(argv);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	async function* source() {
		const reader = child.stream.getReader();
		async function* chunks() {
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) return;
					yield next.value;
				}
			} finally {
				reader.releaseLock();
			}
		}
		try {
			for await (const event of validateWorkspaceArchive(
				chunks(),
				limitsFor(maxBytes),
			))
				yield event.bytes;
			const code = await child.exit;
			await child.stderr();
			if (code !== 0 || timedOut)
				throw new Error("checkpoint: tar capture failed");
		} finally {
			child.kill();
			await Promise.allSettled([child.exit, child.stderr()]);
		}
	}
	try {
		return await saveWorkspaceCheckpoint({
			root: options.root,
			binding,
			maxBytes,
			source: source(),
		});
	} finally {
		clearTimeout(timer);
		child.kill();
		await Promise.allSettled([child.exit, child.stderr()]);
	}
}

/** Raw archive validation completes before any extraction. Both passes
 * read the same nofollow descriptor; neither reopens a pathname. */
export async function validateWorkspaceFile(
	file: FileHandle,
	maxBytes: number,
): Promise<void> {
	for await (const event of validateWorkspaceArchive(
		file.createReadStream({ start: 0, autoClose: false }),
		limitsFor(maxBytes),
	))
		void event;
}

/** Binary stdin with backpressure, bounded diagnostics, and joined exit.
 * This trusted callback is never part of config/model input. */
export async function restoreWorkspace(options: {
	deps: DesktopExecutorDeps;
	record: ExecutorRecord;
	file: FileHandle;
	maxBytes: number;
	operationDeadlineAt?: number;
}): Promise<void> {
	const { deps, record, file, maxBytes } = options;
	const timeoutMs = timeoutFor(
		Math.min(record.deadlineAt ?? 0, options.operationDeadlineAt ?? Infinity),
	);
	const argv = [
		deps.dockerBin ?? "docker",
		"exec",
		"-i",
		record.containerId,
		"tar",
		"--no-same-owner",
		"--no-same-permissions",
		"-C",
		"/workspace",
		"-xf",
		"-",
	];
	const child = Bun.spawn({
		cmd: deps.dockerArgv ? deps.dockerArgv(argv) : argv,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let failed = false;
	const timer = setTimeout(() => {
		failed = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		let bytes = 0;
		const reader = stream.getReader();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) return;
				bytes += next.value.byteLength;
				if (bytes > 65_536) {
					failed = true;
					child.kill("SIGKILL");
				}
			}
		} finally {
			reader.releaseLock();
		}
	};
	const drains = [drain(child.stdout), drain(child.stderr)];
	const feed = (async () => {
		let bytes = 0;
		try {
			for await (const chunk of file.createReadStream({
				start: 0,
				autoClose: false,
			})) {
				bytes += chunk.length;
				if (bytes > maxBytes) throw new Error("checkpoint: byte limit");
				child.stdin.write(chunk);
				await child.stdin.flush();
			}
			await child.stdin.end();
		} catch (error) {
			failed = true;
			child.kill("SIGKILL");
			throw error;
		}
	})();
	try {
		const results = await Promise.allSettled([feed, ...drains, child.exited]);
		if (
			failed ||
			results.some((result) => result.status === "rejected") ||
			(await child.exited) !== 0
		)
			throw new Error("checkpoint: tar restore failed");
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
		await Promise.allSettled([feed, ...drains, child.exited]);
	}
}
