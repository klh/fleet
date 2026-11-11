import type { z } from "zod";
import type { RunOutput } from "../spawn.ts";
import { GUARDIAN } from "./guardian.ts";
import {
	GuestFrameSchema,
	type StartFrameSchema,
	type TransportOptionsSchema,
} from "./protocol.ts";
export interface Command {
	done: Promise<RunOutput>;
	cancel(reason: string): void;
}
type Options = z.output<typeof TransportOptionsSchema>;
type Start = z.output<typeof StartFrameSchema>;
export function launchCommand(
	host: { options: Options; dockerArgv: (argv: readonly string[]) => string[] },
	start: Start,
	limits: { timeoutMs: number; maxBytes: number },
	signal: AbortSignal | undefined,
	taint: () => void,
): Command {
	const options = host.options;
	const proc = Bun.spawn(
		host.dockerArgv([
			options.dockerBin,
			"exec",
			"-i",
			options.containerId,
			"/usr/bin/setsid",
			"--wait",
			"/usr/local/bin/bun",
			"-e",
			GUARDIAN,
		]),
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	let reason: string | undefined,
		exitCode: number | undefined,
		ready = false,
		reapTimer: ReturnType<typeof setTimeout> | undefined;
	let failJoin: (error: Error) => void = () => {};
	const failedJoin = new Promise<never>((_, reject) => {
		failJoin = reject;
	});
	const armReap = () => {
		if (reapTimer) return;
		reapTimer = setTimeout(() => {
			taint();
			proc.kill("SIGKILL");
			failJoin(Error("remote-process.reap-failed"));
		}, options.controlTimeoutMs);
	};
	const cancel = (why: string) => {
		if (reason) return;
		reason = why;
		try {
			proc.stdin.write('{"type":"cancel"}\n');
			void Promise.resolve(proc.stdin.flush()).catch(() => {
				taint();
			});
		} catch {
			taint();
		}
		armReap();
	};
	const abort = () => cancel("aborted");
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const timeout = setTimeout(() => cancel("timeout"), limits.timeoutMs),
		handshake = setTimeout(() => {
			taint();
			cancel("handshake");
		}, options.controlTimeoutMs);
	const chunks = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] },
		sizes = { stdout: 0, stderr: 0 };
	const frame = (line: string) => {
		if (Buffer.byteLength(line) > 32768) throw Error("protocol");
		const value = GuestFrameSchema.parse(JSON.parse(line));
		if (value.type === "ready") {
			if (ready || value.pid !== value.pgrp || value.pid !== value.session)
				throw Error("protocol");
			ready = true;
			clearTimeout(handshake);
			if (!reason) {
				proc.stdin.write(`${JSON.stringify(start)}\n`);
				void Promise.resolve(proc.stdin.flush()).catch(() =>
					cancel("protocol"),
				);
			}
			return;
		}
		if (!ready || exitCode !== undefined || value.type === "error")
			throw Error("protocol");
		if (value.type === "exit") {
			exitCode = value.code;
			armReap();
			return;
		}
		const bytes = Buffer.from(value.data, "base64");
		sizes[value.stream] += bytes.length;
		if (sizes.stdout + sizes.stderr > limits.maxBytes) {
			cancel("output-limit");
			return;
		}
		chunks[value.stream].push(bytes);
	};
	const frames = async () => {
		const reader = proc.stdout.getReader(),
			decoder = new TextDecoder("utf-8", { fatal: true });
		let pending = "";
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				pending += decoder.decode(next.value, { stream: true });
				if (Buffer.byteLength(pending) > 262144) throw Error("protocol");
				let n = pending.indexOf("\n");
				while (n >= 0) {
					frame(pending.slice(0, n));
					pending = pending.slice(n + 1);
					n = pending.indexOf("\n");
				}
				if (Buffer.byteLength(pending) > 32768) throw Error("protocol");
			}
			if (pending || decoder.decode()) throw Error("protocol");
		} catch {
			taint();
			cancel("protocol");
		}
	};
	const errors = async () => {
		const reader = proc.stderr.getReader();
		let count = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) return;
			count += next.value.length;
			if (count > 65536) {
				taint();
				cancel("protocol");
			}
		}
	};
	const joined = Promise.all([frames(), errors(), proc.exited]);
	const done = Promise.race([joined, failedJoin])
		.then(() => {
			if (reason) throw Error(`remote-process.${reason}`);
			if (exitCode === undefined) {
				taint();
				throw Error("remote-process.protocol");
			}
			return {
				code: exitCode,
				stdout: Buffer.concat(chunks.stdout).toString("utf8"),
				stderr: Buffer.concat(chunks.stderr).toString("utf8"),
			};
		})
		.finally(() => {
			clearTimeout(timeout);
			clearTimeout(handshake);
			if (reapTimer) clearTimeout(reapTimer);
			signal?.removeEventListener("abort", abort);
			proc.stdin.end();
		});
	return { cancel, done };
}
