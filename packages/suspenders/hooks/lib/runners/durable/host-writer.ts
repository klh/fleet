import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";

/** Kernel-held local writer exclusion. No PID guessing or stale-file deletion.
 * The storage must be private to this host/network namespace. This is not a
 * distributed lease; the Fleet controller must fence remote job admission.
 * Port collisions fail closed; NEVER pick an alternate port after collision.
 */
export async function acquireHostWriter(
	directory: string,
): Promise<() => Promise<void>> {
	const canonical = await realpath(directory);
	const digest = createHash("sha256").update(canonical).digest();
	const port = 20000 + (digest.readUInt32BE(0) % 39000);
	const server = createServer((socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", () =>
			reject(
				new Error(
					"Durable writer unavailable: another writer or local port collision",
				),
			),
		);
		server.listen({ port, host: "127.0.0.1", exclusive: true }, resolve);
	});
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	};
}
