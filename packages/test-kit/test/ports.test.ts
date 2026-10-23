// test/ports.test.ts — the kit's own suite for freePort()/waitUp():
// reservation reality, readiness resolution, budget timeout.
import { expect, test } from "bun:test";
import { freePort, waitUp } from "../src/ports.ts";

test("freePort: returns a bindable loopback port", async () => {
	const port = await freePort();
	expect(Number.isInteger(port)).toBe(true);
	expect(port).toBeGreaterThan(0);
	// the reservation is real: the port binds again immediately
	const s = Bun.serve({ port, fetch: () => new Response("ok") });
	s.stop(true);
});

test("waitUp: resolves once the url answers ok", async () => {
	const port = await freePort();
	const s = Bun.serve({ port, fetch: () => new Response("ok") });
	try {
		await waitUp(`http://127.0.0.1:${port}`);
	} finally {
		s.stop(true);
	}
});

test("waitUp: throws after the budget on a dead url", async () => {
	const dead = await freePort(); // stopped reservation — nothing listens
	await expect(
		waitUp(`http://127.0.0.1:${dead}`, { tries: 2, intervalMs: 5 }),
	).rejects.toThrow(/did not come up/);
});
