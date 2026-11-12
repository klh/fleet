export async function readHttp(
	url: string,
	init: RequestInit = {},
	options: {
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
		timeoutMs?: number;
		maxBytes?: number;
	} = {},
) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(Error("HTTP deadline exceeded"));
		}, options.timeoutMs ?? 5000);
	});
	try {
		const response = await Promise.race([
			(options.fetch ?? fetch)(url, {
				...init,
				signal: controller.signal,
				redirect: "error",
			}),
			deadline,
		]);
		reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader)
			for (;;) {
				const next = await Promise.race([reader.read(), deadline]);
				if (next.done) break;
				size += next.value.byteLength;
				if (size > (options.maxBytes ?? 65536))
					throw Error("HTTP byte bound exceeded");
				chunks.push(next.value);
			}
		return {
			status: response.status,
			headers: response.headers,
			text: Buffer.concat(chunks).toString("utf8"),
			reads: chunks.length,
		};
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
		if (reader) {
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
}
