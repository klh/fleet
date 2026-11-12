export type Wait = <T>(promise: Promise<T>) => Promise<T>;
/** Deadline covers reads even when an injected peer ignores AbortSignal. */
export async function withDeadline<T>(
	operation: (signal: AbortSignal, wait: Wait) => Promise<T>,
	timeoutMs: number,
	parentSignal?: AbortSignal,
) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("Invalid HTTP deadline");
	parentSignal?.throwIfAborted();
	const controller = new AbortController();
	let expire: (reason: Error) => void = () => {};
	const expired = new Promise<never>((_resolve, reject) => {
		expire = reject;
	});
	const timer = setTimeout(() => {
		controller.abort();
		expire(new Error("Registry request deadline exceeded"));
	}, timeoutMs);
	const onAbort = () => {
		controller.abort();
		expire(new Error("Registry request aborted"));
	};
	parentSignal?.addEventListener("abort", onAbort, { once: true });
	const wait: Wait = (promise) => Promise.race([promise, expired]);
	try {
		return await wait(
			Promise.resolve().then(() => {
				parentSignal?.throwIfAborted();
				return operation(controller.signal, wait);
			}),
		);
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onAbort);
		controller.abort();
	}
}
export async function boundedBody(
	response: Response,
	limit: number,
	wait: Wait = (promise) => promise,
) {
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (response.body) {
		const reader = response.body.getReader();
		try {
			for (;;) {
				const next = await wait(
					reader.read().catch(() => {
						throw Error("Registry response read failed");
					}),
				);
				if (next.done) break;
				size += next.value.length;
				if (size > limit) throw new Error("Registry response byte bound");
				chunks.push(next.value);
			}
		} finally {
			// A peer's cancel hook is untrusted and may never settle.
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}
