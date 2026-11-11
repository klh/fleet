import { runArgv, type RunOutput } from "./spawn.ts";
import {
	InspectSchema,
	StartFrameSchema,
	TransportOptionsSchema,
	RunLimitsSchema,
} from "./remote-process/protocol.ts";
import { launchCommand, type Command } from "./remote-process/command.ts";

export interface RemoteRunOptions {
	stdin?: string;
	timeoutMs?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}
/** Bounded argv carrier, not a complete Pi Shell/FileSystem adapter.
 * run() reports guest-controlled exit status and joins its transport. Same-UID
 * commands can forge frames or escape a group: cleanup() joins tracked commands
 * ONLY. The owner MUST close intake, cleanup(), then assertQuiescent() before
 * any checkpoint/reuse; refusal requires destroying the owned guest. No signal
 * ever targets an observed numeric guest PID from the host.
 * deps is trusted HOST-only routing, separate from validated machine input;
 * its rewrite applies to probes, interactive execution and quiescence. */
export async function createRemoteProcessTransport(
	input: unknown,
	deps: { dockerArgv?: (argv: readonly string[]) => string[] } = {},
) {
	const options = TransportOptionsSchema.parse(input);
	const dockerArgv =
		deps.dockerArgv ?? ((argv: readonly string[]) => [...argv]);
	let closed = false,
		tainted = false;
	const commands = new Set<Command>();
	const inspect = async () => {
		const r = await runArgv(
			dockerArgv([options.dockerBin, "inspect", options.containerId]),
			{ timeoutMs: options.controlTimeoutMs },
		);
		if (r.code !== 0) throw Error("remote-process.identity");
		const parsed = InspectSchema.safeParse(JSON.parse(r.stdout));
		const row = parsed.success ? parsed.data[0] : undefined;
		if (
			!row ||
			row.Id !== options.containerId ||
			row.Config.Image !== options.expectedPinnedImageRef ||
			JSON.stringify(row.Config.Cmd) !== '["sleep","infinity"]'
		)
			throw Error("remote-process.identity");
		return row;
	};
	await inspect();
	const prereq = await runArgv(
		dockerArgv([
			options.dockerBin,
			"exec",
			options.containerId,
			"/usr/local/bin/bun",
			"-e",
			"const f=require('node:fs');for(const p of ['/usr/bin/setsid','/proc/self/stat'])f.accessSync(p);console.log('remote-process-v1')",
		]),
		{ timeoutMs: options.controlTimeoutMs },
	);
	if (prereq.code !== 0 || prereq.stdout.trim() !== "remote-process-v1")
		throw Error("remote-process.prerequisites");
	return {
		async run(
			argv: readonly string[],
			opts: RemoteRunOptions = {},
		): Promise<RunOutput> {
			if (closed || tainted) throw Error("remote-process.closed");
			if (opts.signal?.aborted) throw Error("remote-process.aborted");
			const frame = StartFrameSchema.parse({
				type: "start",
				argv,
				stdin: opts.stdin ?? "",
			});
			const limits = RunLimitsSchema.parse({
				timeoutMs: opts.timeoutMs,
				maxBytes: opts.maxBytes,
			});
			const timeoutMs = Math.min(
				limits.timeoutMs ?? 30_000,
				options.deadlineAt - Date.now(),
			);
			if (timeoutMs <= 0) throw Error("remote-process.timeout");
			const command = launchCommand(
				{ options, dockerArgv },
				frame,
				{ ...limits, timeoutMs },
				opts.signal,
				() => {
					tainted = true;
				},
			);
			commands.add(command);
			try {
				return await command.done;
			} finally {
				commands.delete(command);
			}
		},
		async cleanup() {
			closed = true;
			const active = [...commands];
			for (const c of active) c.cancel("cleanup");
			await Promise.allSettled(active.map((c) => c.done));
			if (tainted) throw Error("remote-process.tainted");
		},
		async assertQuiescent() {
			if (!closed || commands.size || tainted)
				throw Error("remote-process.not-quiescent");
			const row = await inspect();
			const top = await runArgv(
				dockerArgv([
					options.dockerBin,
					"top",
					options.containerId,
					"-eo",
					"pid",
				]),
				{ timeoutMs: options.controlTimeoutMs, maxBytes: 65536 },
			);
			const lines = top.stdout.trim().split(/\r?\n/);
			if (
				top.code !== 0 ||
				lines.shift()?.trim() !== "PID" ||
				lines.length !== 1 ||
				lines[0]?.trim() !== String(row.State.Pid)
			)
				throw Error("remote-process.residue");
		},
	};
}
