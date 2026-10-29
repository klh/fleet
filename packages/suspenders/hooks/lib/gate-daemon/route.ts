// lib/gate-daemon/route.ts — store-server's POST /gate/<event> face (hub
// governor daemon, hub-of-one phase 5). Auth is the caller's (store-server
// applies its /rpc token rule first); this module parses, runs, publishes.
import { z } from "zod";
import { runGate } from "./host.ts";
import { GateRequestSchema, isDaemonEvent } from "./schema.ts";

export type GateRouteDeps = {
	// highest committed events.id, read before the gate runs
	maxEventId: () => number;
	// publish events the gate wrote straight to SQLite (see below)
	publishAfter: (id: number) => void;
};

export async function handleGateRoute(
	req: Request,
	url: URL,
	deps: GateRouteDeps,
): Promise<Response> {
	if (req.method !== "POST")
		return new Response("method not allowed", { status: 405 });
	const event = url.pathname.slice("/gate/".length);
	if (!isDaemonEvent(event))
		return new Response("event not served by the daemon", { status: 404 });
	const parsed = GateRequestSchema.safeParse(
		await req.json().catch(() => null),
	);
	if (!parsed.success)
		return Response.json(
			{ error: z.prettifyError(parsed.error) },
			{ status: 400 },
		);
	const before = deps.maxEventId();
	// The gates' store client is a synchronous curl round trip; inside the
	// store-server it would call this very (blocked) event loop. Gates in
	// the daemon therefore bind the governor.db file directly — the same
	// file the server serves — and the server publishes what they wrote.
	const res = await runGate(event, {
		...parsed.data,
		env: { ...parsed.data.env, GOVERNOR_STORE_URL: "local" },
	});
	deps.publishAfter(before);
	return Response.json(res);
}
