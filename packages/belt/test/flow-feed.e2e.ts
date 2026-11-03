// test/flow-feed.e2e.ts — W2673.1: the belt dashboard's /api/flow proxy —
// window param forwarded verbatim, payload passed through read-only, board
// down = honest ok:false (never a fabricated feed).
import { expect, test } from "@playwright/test";

test.describe("@unit", () => {
	const serveBoard = async (
		body: unknown,
		status = 200,
	): Promise<{ url: string; stop: () => Promise<void> }> => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				expect(new URL(req.url).pathname).toBe("/api/console/flow");
				return new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				});
			},
		});
		return {
			url: `http://127.0.0.1:${server.port}`,
			stop: () => Promise.resolve(server.stop(true)),
		};
	};

	test("forwards window verbatim and passes the payload through", async () => {
		process.env.BELT_BOARD_URL = "http://127.0.0.1:1";
		const { flowFeed } = await import("../bin/flow-feed.ts");
		const board = await serveBoard({ ok: true, windowS: 60, mark: 1 });
		try {
			process.env.BELT_BOARD_URL = board.url;
			const res = await flowFeed(new Request("http://x/api/flow?window=60"));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, windowS: 60, mark: 1 });
		} finally {
			await board.stop();
		}
	});

	test("board down degrades to ok:false, never a fabricated feed", async () => {
		process.env.BELT_BOARD_URL = "http://127.0.0.1:1";
		const { flowFeed } = await import("../bin/flow-feed.ts");
		const res = await flowFeed(new Request("http://x/api/flow"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: false,
			reason: "Board flow feed unavailable",
		});
	});
});
