export type IngressBodyCode = "timeout" | "too_large" | "invalid" | "aborted";
export const INGRESS_BODY_TIMEOUT_MS = 120_000;
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export class IngressBodyError extends Error {
	constructor(readonly code: IngressBodyCode) {
		super(`ingress body ${code}`);
	}
}

/** The Bun connection timer is off for SSE; bound request ingestion here. */
export async function readIngressJson(
	request: Request,
	timeoutMs: number,
	maxBytes: number,
): Promise<unknown> {
	if (!request.body) throw new IngressBodyError("invalid");
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([request.signal, deadline]);
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		await request.body.pipeTo(
			new WritableStream<Uint8Array>({
				write(chunk) {
					bytes += chunk.byteLength;
					if (bytes > maxBytes) throw new IngressBodyError("too_large");
					text += decoder.decode(chunk, { stream: true });
				},
			}),
			{ signal },
		);
	} catch (error) {
		if (deadline.aborted) throw new IngressBodyError("timeout");
		if (request.signal.aborted) throw new IngressBodyError("aborted");
		if (error instanceof IngressBodyError) throw error;
		throw new IngressBodyError("invalid");
	}
	try {
		return JSON.parse(text + decoder.decode()) as unknown;
	} catch {
		throw new IngressBodyError("invalid");
	}
}
