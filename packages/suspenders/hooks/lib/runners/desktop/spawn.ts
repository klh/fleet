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
}

export type RunArgv = (
	argv: string[],
	opts?: RunOptions,
) => Promise<RunOutput>;

/** Spawn argv[0] with the given args; kill after timeoutMs when set.
 *  A missing binary returns code 127 with the OS message — honest
 *  absence, never a fake success. */
export const runArgv: RunArgv = async (argv, opts) => {
	let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn({
			cmd: argv,
			input: opts?.stdin,
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
	const timer = opts?.timeoutMs
		? setTimeout(() => {
				proc.kill();
			}, opts.timeoutMs)
		: null;
	if (timer) timer.unref();
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		return { code, stdout, stderr };
	} finally {
		if (timer) clearTimeout(timer);
	}
};

/** Default binary runner for prereq probes (docker/sbx), bounded. */
export const boundedBinaryRunner =
	(timeoutMs = 8_000): RunArgv =>
	async (argv, opts) =>
		runArgv(argv, { timeoutMs: opts?.timeoutMs ?? timeoutMs });

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
		proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe" });
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
	const stderrText = new Response(proc.stderr).text();
	return {
		stream: proc.stdout,
		exit: proc.exited,
		kill: () => {
			proc.kill();
		},
		stderr: () => stderrText,
	};
};
