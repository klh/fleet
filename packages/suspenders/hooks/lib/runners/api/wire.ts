/** Bounded wire JSON; a hostile peer cannot force an unbounded allocation. */
export async function readWireJson(
	message: Request | Response,
	maxBytes = 65_536,
	timeoutMs = 3_000,
): Promise<unknown> {
	const reader = message.body?.getReader();
	if (!reader) throw new Error("runner.invalid_body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			void reader.cancel().catch(() => {});
			reject(new Error("runner.body_timeout"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			timeout,
			(async () => {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (bytes > maxBytes) throw new Error("runner.body_too_large");
					chunks.push(chunk.value);
				}
				const buffer = new Uint8Array(bytes);
				let offset = 0;
				for (const chunk of chunks) {
					buffer.set(chunk, offset);
					offset += chunk.length;
				}
				return JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(buffer),
				);
			})(),
		]);
	} finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => {});
	}
}
