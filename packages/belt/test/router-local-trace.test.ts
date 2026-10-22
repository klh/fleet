import { expect, test } from "bun:test";
import { openLocalStream, viaLocal } from "../bin/router-core.ts";

const PARENT = "00-11111111111111111111111111111111-2222222222222222-01";

test("buffered and streamed local calls create distinct child spans", async () => {
	const seen: string[] = [];
	const preferences: Array<string | null> = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			seen.push(req.headers.get("traceparent") ?? "");
			preferences.push(req.headers.get("x-klh-prefer"));
			if ((req.headers.get("accept") ?? "").includes("text/event-stream"))
				return new Response(
					'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
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
			preference:
				"v=1;source=dotfile;directive=must;line=1;index=0;target=glm-5.3-flash;can=absent",
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
		expect(preferences).toEqual([opts.preference, opts.preference]);
	} finally {
		server.stop(true);
	}
});
