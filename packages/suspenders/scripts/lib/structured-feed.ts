/** Drain child pipes to EOF; never infer an empty graph from truncated output. */
export async function captureClaimFeed(
	cmd: string[],
	cwd: string,
	options: {
		maxBytes?: number;
		timeoutMs?: number;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<Record<string, unknown>[]> {
	const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
	const proc = Bun.spawn(cmd, {
		cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
	const cancellations: Promise<unknown>[] = [];
	const stop = () => {
		try {
			proc.kill("SIGKILL");
		} catch {
			/* own child already exited */
		}
		for (const reader of readers)
			cancellations.push(reader.cancel().catch(() => {}));
	};
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, options.timeoutMs ?? 15_000);
	async function drain(
		stream: ReadableStream<Uint8Array>,
		cap: number,
	): Promise<string> {
		const reader = stream.getReader();
		readers.add(reader);
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > cap) {
					stop();
					throw new Error(`structured feed exceeds ${cap} bytes`);
				}
				text += decoder.decode(value, { stream: true });
			}
			return text + decoder.decode();
		} finally {
			readers.delete(reader);
			reader.releaseLock();
		}
	}
	const pending = [
		drain(proc.stdout, maxBytes),
		drain(proc.stderr, 64 * 1024),
		proc.exited,
	] as const;
	try {
		const [stdout, stderr, code] = await Promise.all(pending);
		if (timedOut) throw new Error("structured feed command timed out");
		if (code !== 0)
			throw new Error(
				`structured feed command failed (exit ${code}): producer stderr ${Buffer.byteLength(stderr)} bytes`,
			);
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error(
				`invalid or incomplete structured feed (${Buffer.byteLength(stdout)} bytes)`,
			);
		}
		if (
			!Array.isArray(parsed) ||
			parsed.some(
				(row) =>
					!row ||
					typeof row !== "object" ||
					Array.isArray(row) ||
					typeof row.id !== "string",
			)
		)
			throw new Error("structured feed must be an array of work-item objects");
		return parsed;
	} catch (error) {
		stop();
		await Promise.allSettled([...pending, ...cancellations]);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
