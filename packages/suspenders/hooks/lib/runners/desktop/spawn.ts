// spawn.ts — W2869.3: the one argv-array process runner for the desktop
// runner leaf. No shell, no string command lines: every docker/sbx probe
// rides argv arrays through Bun.spawn, stdin rides the spawn `input`
// (async spawn honors it; spawnSync ignores it), and every wait is
// bounded by a kill-timer so a hung docker daemon cannot strand a lane.
export interface RunOutput {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	stdin?: string;
	timeoutMs?: number;
	/** Cancel only this HOST-owned subprocess, and join its exit and pipes. */
	signal?: AbortSignal;
	/** Host-side drain ceiling per pipe — the child is KILLED on excess
	 *  (model-controlled output must not OOM the host, root #117936). */
	maxBytes?: number;
}

export type RunArgv = (argv: string[], opts?: RunOptions) => Promise<RunOutput>;

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Bounded pipe drain: kills the child when capBytes is crossed and keeps
 * draining (discarding) so the killed child's pipes never backpressure. */
const drainBounded = async (
	stream: ReadableStream<Uint8Array>,
	capBytes: number,
	kill: () => void,
): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (truncated) continue;
		total += value.byteLength;
		if (total > capBytes) {
			truncated = true;
			kill();
			continue;
		}
		chunks.push(value);
	}
	let out = new Uint8Array(0);
	for (const c of chunks) {
		const merged = new Uint8Array(out.byteLength + c.byteLength);
		merged.set(out);
		merged.set(c, out.byteLength);
		out = merged;
	}
	return { bytes: out, truncated };
};

/** Spawn argv[0] with the given args; kill after timeoutMs when set.
 *  A missing binary returns code 127 with the OS message — honest
 *  absence, never a fake success. */
export const runArgv: RunArgv = async (argv, opts) => {
	const signal = opts?.signal;
	signal?.throwIfAborted();
	let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn({
			cmd: argv,
			// Bun 1.4.4 IGNORES spawn `input` (root #117937) — stdin rides as
			// raw bytes; empty bytes = immediate EOF.
			stdin: new TextEncoder().encode(opts?.stdin ?? ""),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		return {
			code: 127,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
		};
	}
	const cap = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
	const kill = () => proc.kill("SIGKILL");
	signal?.addEventListener("abort", kill, { once: true });
	if (signal?.aborted) kill();
	const timer = setTimeout(kill, opts?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
	timer.unref();
	const drains = [
		drainBounded(proc.stdout, cap, kill),
		drainBounded(proc.stderr, cap, kill),
	] as const;
	try {
		const [stdout, stderr] = await Promise.all(drains);
		const code = await proc.exited;
		const mk = (d: { bytes: Uint8Array; truncated: boolean }): string => {
			const text = new TextDecoder().decode(d.bytes);
			return d.truncated
				? `${text}\n[runArgv: pipe truncated at ${cap} bytes — child killed]`
				: text;
		};
		return { code, stdout: mk(stdout), stderr: mk(stderr) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", kill);
		kill();
		await Promise.allSettled([...drains, proc.exited]);
	}
};

/** Default binary runner for prereq probes (docker/sbx), bounded. */
export const boundedBinaryRunner =
	(timeoutMs = 8_000): RunArgv =>
	async (argv, opts) =>
		runArgv(argv, {
			timeoutMs: opts?.timeoutMs ?? timeoutMs,
			signal: opts?.signal,
		});

export interface StreamRun {
	/** Raw stdout byte stream — the artifact export walks `docker cp … -`
	 *  incrementally at tar-header granularity. */
	stream: ReadableStream<Uint8Array>;
	exit: Promise<number>;
	kill(): void;
	stderr(): Promise<string>;
}

/** Spawn argv[0] with stdout as a raw byte stream; stderr is drained
 *  eagerly into a promise so the pipe never backpressures the child. */
export const runArgvStream = async (argv: string[]): Promise<StreamRun> => {
	let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn({
			cmd: argv,
			stdin: new TextEncoder().encode(""),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			stream: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			exit: Promise.resolve(127),
			kill: () => {},
			stderr: () => Promise.resolve(message),
		};
	}
	const cap = DEFAULT_MAX_BYTES;
	const timer = setTimeout(() => {
		proc.kill("SIGKILL");
	}, 60_000);
	timer.unref();
	const stderrText = drainBounded(proc.stderr, cap, () => {
		proc.kill("SIGKILL");
	}).then((d) =>
		d.truncated
			? `${new TextDecoder().decode(d.bytes)}\n[runArgvStream: stderr truncated at ${cap} bytes — child killed]`
			: new TextDecoder().decode(d.bytes),
	);
	return {
		stream: proc.stdout,
		exit: proc.exited,
		kill: () => {
			proc.kill("SIGKILL");
			clearTimeout(timer);
		},
		stderr: () => stderrText,
	};
};
