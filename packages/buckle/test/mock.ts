// test/mock.ts — mock upstream server for router/handler tests: records
// calls, replays a scripted handler, random loopback port. W1135.1.5: the
// stub body is @klh/test-kit serveStub (identical recording semantics);
// this file keeps the MockCall/MockUpstream faces its importers assert
// against.
import { serveStub, type StubHandler, type StubRequest } from "@klh/test-kit";

export type MockCall = StubRequest;

export interface MockUpstream {
	url: string;
	port: number;
	calls: MockCall[];
	close(): void;
}

export type Handler = StubHandler;

export async function startMockUpstream(
	handler: Handler,
	opts?: { hostname?: string },
): Promise<MockUpstream> {
	const stub = serveStub(handler, opts);
	return {
		url: stub.url,
		port: stub.port,
		calls: stub.requests,
		close: stub.close,
	};
}
