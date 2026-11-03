// test/flow-feed.e2e.ts — W2673.1: the belt dashboard's /api/flow proxy —
// window param forwarded verbatim, payload passed through read-only, board
// down = honest ok:false (never a fabricated feed).
import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

test.describe("@unit", () => {
	test("forwards window verbatim and passes the payload through", async () => {
		process.env.BELT_BOARD_URL = "http://127.0.0.1:1";
		const { flowFeed } = await import("../bin/flow-feed.ts");
		// W2673.3: kit stub (W1135.1.3) — the recorded path plus the captured
		// search pin the ?window forwarding the proxy owes the board route.
		let forwardedSearch = "";
		const board = serveStub((req) => {
			forwardedSearch = new URL(req.url).search;
			return new Response(JSON.stringify({ ok: true, windowS: 60, mark: 1 }), {
				headers: { "content-type": "application/json" },
			});
		});
		try {
			process.env.BELT_BOARD_URL = board.url;
			const res = await flowFeed(new Request("http://x/api/flow?window=60"));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, windowS: 60, mark: 1 });
			expect(board.requests).toHaveLength(1);
			expect(board.requests[0]?.path).toBe("/api/console/flow");
			expect(forwardedSearch).toBe("?window=60");
		} finally {
			board.close();
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
