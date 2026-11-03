// bin/flow-feed.ts — W2673.1: the gateway flow feed as served by the belt
// dashboard (:7791/api/flow). Read-only proxy to the board's windowed
// request-edge aggregation (fleet-board /api/console/flow → buckle's
// flow-read-model); the window query param rides verbatim and the read
// model normalizes it (60|300|600 seconds, anything else = 300).
const json = (x: unknown, status = 200): Response =>
	new Response(JSON.stringify(x), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});

export const flowFeed = async (req: Request): Promise<Response> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2500);
	try {
		const base = process.env.BELT_BOARD_URL ?? "http://127.0.0.1:7799";
		const url = new URL(req.url);
		const target = new URL("/api/console/flow", base);
		if (url.searchParams.has("window"))
			target.searchParams.set("window", url.searchParams.get("window") ?? "");
		const response = await fetch(target, { signal: controller.signal });
		if (!response.ok)
			return json({ ok: false, reason: "Board flow feed unavailable" });
		return json(await response.json());
	} catch {
		return json({ ok: false, reason: "Board flow feed unavailable" });
	} finally {
		clearTimeout(timeout);
	}
};
