import { expect, test } from "bun:test";
import { openLocalStream, viaLocal } from "../bin/router-core.ts";

const PARENT = "00-11111111111111111111111111111111-2222222222222222-01";

test("buffered and streamed local calls create distinct child spans", async () => {
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			seen.push(req.headers.get("traceparent") ?? "");
			if ((req.headers.get("accept") ?? "").includes("text/event-stream"))
				return new Response("data: [DONE]\n\n", {
					headers: { "content-type": "text/event-stream" },
				});
			return Response.json({
				choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
			});
		},
	});
	try {
		const route = { port: 8902, model: "test" };
		const opts = {
			base: `http://127.0.0.1:${server.port}`,
			traceparent: PARENT,
			requestId: "belt_1234567890abcdef",
		};
		const buffered = await viaLocal(route, [], 8, 0, opts);
		expect(buffered.ok).toBe(true);
		const streamed = await openLocalStream(route, [], 8, 0, opts);
		expect(streamed.ok).toBe(true);
		if (streamed.ok) await streamed.body.cancel();
		expect(seen).toHaveLength(2);
		expect(
			seen.every((id) => id.startsWith("00-11111111111111111111111111111111-")),
		).toBe(true);
		expect(new Set(seen).size).toBe(2);
	} finally {
		server.stop(true);
	}
});
