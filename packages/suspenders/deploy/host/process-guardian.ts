import { dlopen, FFIType } from "bun:ffi";
import {
	CHUNK_BYTES,
	MAX_CONTROL_BYTES,
	StartSchema,
} from "./process-protocol.ts";

/** Trusted HOST tooling only. Refuse direct/non-isolated invocation before signalling. */
async function main() {
	const library =
		process.platform === "darwin"
			? "/usr/lib/libSystem.B.dylib"
			: process.platform === "linux"
				? "libc.so.6"
				: null;
	if (!library) throw new Error("Unsupported HOST guardian platform");
	const native = dlopen(library, {
		getpid: { args: [], returns: FFIType.i32 },
		getpgrp: { args: [], returns: FFIType.i32 },
		getsid: { args: [FFIType.i32], returns: FFIType.i32 },
	});
	const pid = native.symbols.getpid();
	const pgid = native.symbols.getpgrp();
	const sid = native.symbols.getsid(0);
	native.close();
	if (pid !== process.pid || pid !== pgid || pid !== sid)
		throw new Error("HOST guardian requires its own session");
	const killOwnGroup = () => {
		process.kill(0, "SIGKILL");
	};
	process.on("SIGTERM", killOwnGroup);
	process.on("SIGINT", killOwnGroup);
	let outbound = Promise.resolve();
	const send = (frame: unknown) => {
		const line = `${JSON.stringify(frame)}\n`;
		outbound = outbound.then(async () => {
			await Bun.write(Bun.stdout, line);
		});
		return outbound;
	};
	let watchdog = setTimeout(killOwnGroup, 2000);
	await send({ type: "ready", pid, pgid, sid });
	try {
		const parts: Uint8Array[] = [];
		let length = 0;
		for await (const part of Bun.stdin.stream()) {
			length += part.length;
			if (length >= MAX_CONTROL_BYTES) throw new Error("Control byte bound");
			parts.push(part);
		}
		const control = new Uint8Array(length);
		let offset = 0;
		for (const part of parts) {
			control.set(part, offset);
			offset += part.length;
		}
		const start = StartSchema.parse(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(control)),
		);
		clearTimeout(watchdog);
		watchdog = setTimeout(killOwnGroup, start.timeoutMs);
		let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			child = Bun.spawn(start.argv, {
				cwd: start.cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch {
			await send({ type: "failure", reason: "spawn" });
			killOwnGroup();
			return;
		}
		let total = 0;
		const pump = async (
			stream: ReadableStream<Uint8Array>,
			channel: "stdout" | "stderr",
		) => {
			for await (const chunk of stream) {
				total += chunk.length;
				if (total > start.maxBytes) {
					await send({ type: "failure", reason: "overflow" });
					killOwnGroup();
					return;
				}
				for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES)
					await send({
						type: "data",
						channel,
						data: Buffer.from(
							chunk.subarray(offset, offset + CHUNK_BYTES),
						).toString("base64"),
					});
			}
		};
		await Promise.all([
			child.exited,
			pump(child.stdout, "stdout"),
			pump(child.stderr, "stderr"),
		]);
		await send({
			type: "exit",
			code: child.exitCode,
			signal: child.signalCode,
		});
		// Joined pipe EOFs precede completion; remove any same-group background tooling too.
		killOwnGroup();
	} catch {
		await send({ type: "failure", reason: "protocol" }).catch(() => {});
		killOwnGroup();
	} finally {
		clearTimeout(watchdog);
	}
}
if (import.meta.main)
	main().catch(() => {
		// No kill handler/group action is installed if isolation verification failed.
		console.error("HOST guardian refused non-isolated/unsupported invocation");
		process.exitCode = 2;
	});
