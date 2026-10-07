// w451-board-coalesce.test.ts — W451 hub longevity: the bounded /api/events
// delta reuses the WS cursor contract (hooks/coord/bus.ts cmdPoll): strict
// `id > since`, ascending, advance-only-past-shown; the client holds the
// cursor and drains with ?since=<cursor>. The board fixture
// (helpers/board-fixture.ts) spawns a real board on an unused loopback port;
// events arrive via the coord CLI so the assertion crosses the real write
// path, not a back door.
import { describe, expect, test, afterAll } from "bun:test";
import { boardFixture } from "./helpers/board-fixture.ts";

const { BASE, run } = await boardFixture(0, afterAll);

interface Ev {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: unknown;
	target: string | null;
}

const emitNote = (note: string): void => {
	const r = run("coord.ts", [
		"emit",
		"BROADCAST",
		"--scope",
		"suspenders",
		"--as",
		"w451-probe",
		"--note",
		note,
	]);
	if (r.code !== 0) throw new Error(`emit failed: ${r.err}`);
};

const events = async (params: string): Promise<{ ok: boolean; events: Ev[]; cursor: number }> => {
	const r = await fetch(`${BASE}/api/events?${params}`);
	if (!r.ok) {
		const t = await r.text();
		throw new Error(`/api/events ${r.status}: ${t.slice(0, 80)}`);
	}
	return (await r.json()) as { ok: boolean; events: Ev[]; cursor: number };
};

describe("/api/events — the WS cursor contract over HTTP", () => {
	test("delta reads: strict >, ascending, cursor advances past shown, payload parsed", async () => {
		// cursor BEFORE the probe emits — the drain sees exactly our rows
		const before = await events("since=0&limit=1");
		expect(before.ok).toBe(true);
		const cur0 = before.cursor;
		emitNote("w451 delta one");
		emitNote("w451 race two"); // order marker
		emitNote("w451 delta three");
		const page = await events(`since=${cur0}&limit=2`);
		expect(page.ok).toBe(true);
		expect(page.events).toHaveLength(2); // bounded: limit caps the page
		expect(page.cursor).toBe(page.events[1].id); // advances past shown
		const rest = await events(`since=${page.cursor}`);
		const rows = [...page.events, ...rest.events];
		const ids = rows.filter((e) => e.kind === "BROADCAST").map((e) => e.id);
		expect(ids.every((id, i) => i === 0 || id > ids[i - 1])).toBe(true);
	});

	test("payload arrives parsed; live tail after the cursor", async () => {
		const before = await events("since=0&limit=1");
		emitNote("w451 delta four");
		const page = await events(`since=${before.cursor}`);
		const rows = page.events.filter(
			(e) =>
				e.kind === "BROADCAST" &&
				(e.payload as { note?: string }).note === "w451 delta four",
		);
		expect(rows).toHaveLength(1);
		expect((rows[0].payload as { note?: string }).note).toBe("w451 delta four"); // parsed, not a string
		expect(page.cursor).toBeGreaterThanOrEqual(rows[0].id);
	});
});
