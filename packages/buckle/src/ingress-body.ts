export type IngressBodyCode = "timeout" | "too_large" | "invalid" | "aborted";
export const INGRESS_BODY_TIMEOUT_MS = 120_000;
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export class IngressBodyError extends Error {
	constructor(readonly code: IngressBodyCode) {
		super(`ingress body ${code}`);
	}
}

/** The rejection each IngressBodyCode maps to on the gov/admin/aids routes:
 *  same 400 shape the bare req.json paths answered, plus honest 408/413. */
const REJECTS: Record<
	IngressBodyCode,
	{ status: 400 | 408 | 413; code: string; why: string }
> = {
	timeout: {
		status: 408,
		code: "buckle.body_timeout",
		why: "request body deadline exceeded",
	},
	too_large: {
		status: 413,
		code: "buckle.body_too_large",
		why: "request body too large",
	},
	invalid: { status: 400, code: "buckle.bad_body", why: "invalid JSON body" },
	aborted: { status: 400, code: "buckle.bad_body", why: "invalid JSON body" },
};

export type IngressRead =
	| { ok: true; body: unknown }
	| { ok: false; status: 400 | 408 | 413; code: string; why: string };

export type BoundedRequest =
	| { ok: true; request: Request }
	| { ok: false; status: 400 | 408 | 413; code: string; why: string };

/** Admit a request before any route or auth handler sees its body. Bun's
 * maxRequestBodySize replies before fetch, so it cannot attach a trace. This
 * reader keeps the same 32 MiB effective cap and 120s body deadline. A
 * declared excess is rejected without reading; chunked bodies are counted
 * incrementally and cancelled as soon as they cross the cap. Accepted bytes
 * stay bounded in memory until EOF: forwarding them earlier would let a
 * route act before a later chunk reveals an oversized request. */
export async function boundedIngressRequest(
	request: Request,
	maxBytes: number = MAX_REQUEST_BODY_BYTES,
	timeoutMs: number = INGRESS_BODY_TIMEOUT_MS,
): Promise<BoundedRequest> {
	const reject = (code: IngressBodyCode): BoundedRequest => ({
		ok: false,
		...REJECTS[code],
	});
	const declared = request.headers.get("content-length");
	if (
		declared &&
		/^[0-9]+$/.test(declared) &&
		BigInt(declared) > BigInt(maxBytes)
	) {
		void request.body?.cancel().catch(() => {});
		return reject("too_large");
	}
	if (!request.body) return { ok: true, request };
	const reader = request.body.getReader();
	const deadline = AbortSignal.timeout(timeoutMs);
	const cancel = (): void => {
		void reader.cancel().catch(() => {});
	};
	request.signal.addEventListener("abort", cancel, { once: true });
	deadline.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (deadline.aborted) return reject("timeout");
			if (request.signal.aborted) return reject("aborted");
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				cancel();
				return reject("too_large");
			}
			chunks.push(value);
		}
		// A declared body shorter than promised is a malformed request, never
		// replayed as complete to an authenticated route.
		if (
			declared &&
			/^[0-9]+$/.test(declared) &&
			BigInt(declared) !== BigInt(bytes)
		)
			return reject("invalid");
		if (request.method === "GET" || request.method === "HEAD")
			return reject("invalid");
		return {
			ok: true,
			request: new Request(request, { body: new Blob(chunks) }),
		};
	} catch {
		cancel();
		if (deadline.aborted) return reject("timeout");
		if (request.signal.aborted) return reject("aborted");
		return reject("invalid");
	} finally {
		request.signal.removeEventListener("abort", cancel);
		deadline.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** Request-lifetime deadline/budget/path headers are W1086's shared
 *  contract (packages/telemetry hop-contract.ts, x-klh-hop-contract,
 *  deadline=13-digit abs epoch-ms). Buckle adopts that header — no
 *  competing name lives here. */

/** Bounded JSON read for the secondary body paths (admin, federation,
 *  aids, repo-policy): the same deadline/size/abort bounds as the proxy
 *  ingress, mapped onto a rejection object the route answers directly. */
export async function readBoundedJson(
	request: Request,
	timeoutMs: number = INGRESS_BODY_TIMEOUT_MS,
	maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<IngressRead> {
	try {
		return {
			ok: true,
			body: await readIngressJson(request, timeoutMs, maxBytes),
		};
	} catch (error) {
		const code = error instanceof IngressBodyError ? error.code : "invalid";
		return { ok: false, ...REJECTS[code] };
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
