// W761 — lane death capture: prune banks the log tail + lifetime so
// childless lanes stop dying as mysteries; the grinder breaker reads the
// same facts (sub-minute death ratio trips, window-decayed).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	captureLaneDeaths,
	logTail,
	grinderVerdict,
} from "../scripts/lib/lane-death-capture.ts";

function fixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	return db as unknown as GovernorStore;
}

test("logTail reads the last bytes and tolerates missing files", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-death-"));
	try {
		const p = join(dir, "lane-x.log");
		writeFileSync(p, `${"x".repeat(5000)}THE END`);
		expect(logTail(p).endsWith("THE END")).toBe(true);
		expect(logTail(p).length).toBeLessThanOrEqual(4096);
		expect(logTail(join(dir, "nope.log"))).toBe("");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("captureLaneDeaths banks tail + lifetime per pruned sid", () => {
	const store = fixture();
	const dir = mkdtempSync(join(tmpdir(), "lane-death-"));
	try {
		writeFileSync(join(dir, "lane-a1.log"), "died doing x");
		const now = Date.now();
		captureLaneDeaths(
			store,
			dir,
			[{ sid: "a1", item: "W1", launchedAt: now - 240_000 }],
			now,
		);
		const row = store
			.query("SELECT value FROM facts WHERE key='lane.a1.death'")
			.get() as { value: string } | undefined;
		expect(row).toBeDefined();
		const j = JSON.parse(row?.value ?? "{}") as {
			livedMs: number;
			tail: string;
		};
		expect(j.tail).toBe("died doing x");
		expect(j.livedMs).toBeGreaterThan(200_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("grinderVerdict trips on in-window sub-minute deaths and decays", () => {
	const now = Date.now();
	const fresh = Array.from({ length: 5 }, (_, i) => ({
		value: JSON.stringify({ livedMs: 20_000 }),
		ts: now - i * 60_000,
	}));
	const tripped = grinderVerdict(fresh, now);
	expect(tripped.tripped).toBe(true);
	expect(tripped.samples).toBe(5);
	const aged = fresh.map((r) => ({ ...r, ts: now - 40 * 60_000 }));
	expect(grinderVerdict(aged, now).tripped).toBe(false);
	const healthy = [
		...fresh.slice(0, 2),
		{
			value: JSON.stringify({ livedMs: 3_600_000 }),
			ts: now,
		},
	];
	expect(grinderVerdict(healthy, now).tripped).toBe(false);
});
