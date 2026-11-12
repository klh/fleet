import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
	FrameSchema,
	MAX_FRAME_BYTES,
	StartSchema,
} from "./process-protocol.ts";

export type HostProcessResult = {
	code: number | null;
	signal: string | null;
	stdout: Uint8Array;
	stderr: Uint8Array;
};
export type HostProcessOptions = {
	cwd?: string;
	timeoutMs: number;
	maxBytes?: number;
	signal?: AbortSignal;
};
/** Bounded trusted HOST argv and inherited same-group descendants.
 * Deliberately detached/hostile descendants are outside this tooling contract;
 * sandbox containment remains Docker's responsibility. Uncertain cleanup refuses. */
export async function hostProcess(
	argv: readonly string[],
	options: HostProcessOptions,
): Promise<HostProcessResult> {
	const start = StartSchema.parse({
		argv: [...argv],
		cwd: resolve(options.cwd ?? process.cwd()),
		timeoutMs: options.timeoutMs,
		maxBytes: options.maxBytes ?? 1024 * 1024,
	});
	options.signal?.throwIfAborted();
	const started = performance.now();
	return new Promise((resolveResult, rejectResult) => {
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("./process-guardian.ts", import.meta.url))],
			{
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				cwd: start.cwd,
			},
		);
		let ready = false;
		let terminal: { code: number | null; signal: string | null } | undefined;
		let failed: Error | undefined;
		let stopped = false;
		let uncertain = false;
		let pending = Buffer.alloc(0);
		let total = 0;
		let diagnosticBytes = 0;
		const stdout: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		let hardStop: ReturnType<typeof setTimeout> | undefined;
		const stop = (reason: string) => {
			failed ??= new Error(reason);
			if (stopped) return;
			stopped = true;
			if (child.exitCode === null && child.signalCode === null)
				child.kill(ready ? "SIGTERM" : "SIGKILL");
			hardStop = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					uncertain = true;
					child.kill("SIGKILL"); // Captured guardian only; never a recycled observed group ID.
				}
			}, 1000);
		};
		const timer = setTimeout(
			() => stop("HOST command deadline exceeded"),
			start.timeoutMs,
		);
		const onAbort = () => stop("HOST command aborted");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		child.on("error", () => stop("HOST guardian spawn failed"));
		child.stdin.on("error", () => stop("HOST guardian control pipe failed"));
		child.stdout.on("error", () => stop("HOST guardian output pipe failed"));
		child.stderr.on("error", () =>
			stop("HOST guardian diagnostic pipe failed"),
		);
		child.stderr.on("data", (chunk: Buffer) => {
			diagnosticBytes += chunk.length;
			if (diagnosticBytes > 4096) stop("HOST guardian diagnostic byte bound");
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (failed) return;
			pending = Buffer.concat([pending, chunk]);
			for (;;) {
				const newline = pending.indexOf(10);
				if (newline < 0) {
					if (pending.length > MAX_FRAME_BYTES)
						stop("HOST guardian frame byte bound");
					return;
				}
				if (newline > MAX_FRAME_BYTES) {
					stop("HOST guardian frame byte bound");
					return;
				}
				const line = pending.subarray(0, newline);
				pending = pending.subarray(newline + 1);
				try {
					const frame = FrameSchema.parse(JSON.parse(line.toString("utf8")));
					if (frame.type === "ready") {
						if (
							ready ||
							frame.pid !== child.pid ||
							frame.pgid !== child.pid ||
							frame.sid !== child.pid
						)
							throw new Error("HOST guardian isolation mismatch");
						ready = true;
						child.stdin.end(JSON.stringify(start));
					} else if (!ready || terminal)
						throw new Error("HOST guardian frame ordering");
					else if (frame.type === "data") {
						const bytes = Buffer.from(frame.data, "base64");
						if (bytes.toString("base64") !== frame.data)
							throw new Error("HOST guardian noncanonical data");
						total += bytes.length;
						if (total > start.maxBytes)
							throw new Error("HOST output byte bound");
						(frame.channel === "stdout" ? stdout : stderr).push(bytes);
					} else if (frame.type === "failure")
						stop(`HOST command ${frame.reason}`);
					else terminal = { code: frame.code, signal: frame.signal };
				} catch {
					stop("HOST guardian protocol failed");
					return;
				}
			}
		});
		child.once("close", (_code, signal) => {
			clearTimeout(timer);
			if (hardStop) clearTimeout(hardStop);
			options.signal?.removeEventListener("abort", onAbort);
			if (performance.now() - started >= start.timeoutMs)
				failed ??= new Error("HOST command deadline exceeded");
			if (options.signal?.aborted) failed ??= new Error("HOST command aborted");
			if (uncertain) failed = new Error("HOST guardian cleanup uncertain");
			if (!ready || !terminal || signal !== "SIGKILL" || pending.length)
				failed ??= new Error(
					"HOST guardian exited without joined terminal proof",
				);
			if (failed || !terminal) {
				rejectResult(failed ?? new Error("HOST command failed"));
				return;
			}
			resolveResult({
				...terminal,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			});
		});
	});
}
