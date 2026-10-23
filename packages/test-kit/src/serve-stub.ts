// src/serve-stub.ts — serveStub(): stub upstream with call recording
// (W1135.1.3). Verbatim semantics of the audited idiom (buckle test/mock.ts
// startMockUpstream): scratch loopback port, every request recorded into
// `requests` before the handler answers, programmable handler responses.
export interface StubRequest {
	/** Request pathname. */
	path: string;
	/** Parsed JSON body, null when the body is not JSON. */
	body: Record<string, unknown> | null;
	/** Authorization header, null when absent. */
	auth: string | null;
	/** Full request headers. */
	headers: Headers;
	/** 1-based request number. */
	n: number;
}

export interface ServeStub {
	/** `http://127.0.0.1:<port>` */
	url: string;
	port: number;
	/** Every recorded request, in arrival order. */
	requests: StubRequest[];
	close(): void;
}

export type StubHandler = (
	req: Request,
	body: Record<string, unknown> | null,
	n: number,
) => Response | Promise<Response>;

/** Stub upstream on a scratch loopback port. The handler gets (req, parsed
 *  json body-or-null, 1-based request number) and answers programmatically;
 *  the default handler answers 200 "ok". */
export function serveStub(
	handler: StubHandler = () => new Response("ok"),
	opts?: { hostname?: string },
): ServeStub {
	const requests: StubRequest[] = [];
	const server = Bun.serve({
		hostname: opts?.hostname ?? "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json().catch(() => null)) as Record<
				string,
				unknown
			> | null;
			requests.push({
				path: new URL(req.url).pathname,
				body,
				auth: req.headers.get("authorization"),
				headers: req.headers,
				n: requests.length + 1,
			});
			return handler(req, body, requests.length);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port ?? 0,
		requests,
		close: () => server.stop(true),
	};
}
