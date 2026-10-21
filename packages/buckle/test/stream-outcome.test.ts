import { expect, test } from "bun:test";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const poolOf = (url: string): UpstreamPool => ({
	groups: () => ["claude-sonnet-5"],
	deployments: (group) => [{ group, url, dialect: "anthropic" as const }],
});

test("an upstream that dies after SSE headers is recorded as a failed request", async () => {
	let failUpstream: (() => void) | undefined;
	const upstream = await startMockUpstream(
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
							),
						);
						failUpstream = () =>
							controller.error(new Error("upstream connection dropped"));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	try {
		const deps = testDeps(poolOf(upstream.url));
		const response = await createApp(deps).fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
			}),
		);
		expect(response.status).toBe(200);
		expect(deps.ledger.auditRows()[0]?.status).toBeNull();
		failUpstream?.();
		const text = await response.text();
		expect(text).toContain("stream_failed");
		await Bun.sleep(20);
		const audit = deps.ledger.auditRows()[0];
		expect(audit?.ok).toBe(0);
		expect(audit?.error_code).toBe("stream_failed");
		expect(audit?.decision).toBe("errored");
	} finally {
		upstream.close();
	}
});
