// W947 — consult-ingress worker bounds (verdict #47393 finding 3).
// Per-spawn timeout + request-body cap, pinned via env into a dedicated
// board fixture: the 1ms pin would 502 every consult on the shared
// fixture, so this file runs its own board with the pins set.
import { expect, test } from "@playwright/test";
import { boardFixture } from "./helpers/board-fixture.ts";

process.env.SUSPENDERS_CONSULT_SPAWN_TIMEOUT_MS = "1";
process.env.SUSPENDERS_CONSULT_MAX_CONCURRENT = "1";

test.setTimeout(30_000);
const f = await boardFixture(0, (fn) => test.afterAll(fn));
// W670: the fixture snapshotted its env copy — unpin NOW so later test
// files in the same process do not inherit the 1ms timeout / cap=1
delete process.env.SUSPENDERS_CONSULT_SPAWN_TIMEOUT_MS;
delete process.env.SUSPENDERS_CONSULT_MAX_CONCURRENT;
// the ingress validates {project} against the registered project list
f.addWork("W947 worker bounds seed");

test.describe("W947 consult worker bounds", () => {
	test("spawn timeout kills the CLI and surfaces 502 honestly", async () => {
		const r = await f.post("/api/consult", {
			project: f.MY_PROJ,
			sid: "w947-timeout",
			q: "probe the spawn timeout",
			best: true,
		});
		expect(r.status).toBe(502);
		expect(String(r.json.output)).toContain("timed out");
	});

	test("body past BODY_CAP 413s before any spawn", async () => {
		const q = "x".repeat(70_000);
		const r = await f.post("/api/consult", {
			project: f.MY_PROJ,
			sid: "w947-bodycap",
			q,
		});
		expect(r.status).toBe(413);
	});

	test("MAX_CONCURRENT=1 serializes without dropping requests", async () => {
		// cap=1 + the 1ms spawn timeout still queue (semaphore releases and
		// re-acquires per spawn); each request completes with a response
		const ask = (i: number) =>
			f.post("/api/consult", {
				project: f.MY_PROJ,
				sid: "w947-serial",
				q: `serial probe ${i}`,
				best: true,
			});
		const rs = await Promise.all([ask(0), ask(1), ask(2)]);
		for (const r of rs) expect([413, 502]).toContain(r.status);
	});
});

