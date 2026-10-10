// W613 pins: executor-scoped reclaim (local evidence only for this
// executor's grants), foreign claims expire by store-hb age with grace
// ≥ 2× hb interval, tri-state probe — unknown never releases — and dead
// must repeat on consecutive sweeps before the CAS release fires.
import { describe, expect, test } from "bun:test";
import { openMemoryStore, type GovernorStore } from "../hooks/lib/govdb.ts";
import {
	DEAD_REQUIRED,
	claimLivenessTables,
	extendClaim,
	observeClaim,
	parseForMs,
	sweepReclaims,
} from "../hooks/lib/claim-liveness.ts";
import { executorId, sameExecutor } from "../hooks/lib/lane-liveness.ts";

const NOW = 1_800_000_000_000;

function seed(items: { id: string; owner: string; origin: string | null }[]) {
	const store = openMemoryStore() as GovernorStore & { local: boolean };
	store.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'READY', owner_sid TEXT, origin TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	store.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, hb INTEGER NOT NULL)",
	);
	store.run(
		"CREATE TABLE claims (sid TEXT, scope TEXT, intent TEXT, hot INTEGER DEFAULT 0, ts INTEGER, tp TEXT)",
	);
	store.run(
		"CREATE TABLE events (ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	for (const it of items)
		store.run(
			"INSERT INTO work_items (project, id, state, owner_sid, origin, created_at, updated_at) VALUES ('p', ?, 'CLAIMED', ?, ?, ?, ?)",
			it.id,
			it.owner,
			it.origin,
			NOW,
			NOW,
		);
	return store;
}

const row = (store: GovernorStore, id: string) =>
	store
		.query("SELECT * FROM work_items WHERE project = 'p' AND id = ?")
		.get(id) as {
		id: string;
		owner_sid: string;
		origin: string | null;
		state: string;
		updated_at: number;
	};

const EXEC = `${executorId()}:claude`;

describe("parseForMs (work extend --for)", () => {
	test("magnitude+unit only", () => {
		expect(parseForMs("45m")).toBe(45 * 60_000);
		expect(parseForMs("90s")).toBe(90_000);
		expect(parseForMs("2h")).toBe(2 * 3_600_000);
		expect(parseForMs("45")).toBeNull();
		expect(parseForMs("m")).toBeNull();
		expect(parseForMs("-5m")).toBeNull();
		expect(parseForMs(undefined)).toBeNull();
	});
});

describe("extendClaim (W613 pre-extend)", () => {
	test("refuses foreign owners and non-claims; CAS on the live claim", () => {
		const store = seed([{ id: "W1", owner: "autowx", origin: EXEC }]);
		const foreign = extendClaim(store, {
			project: "p",
			id: "W1",
			sid: "autow-other",
			forMs: 60_000,
		});
		expect(foreign.ok).toBe(false);
		const ok = extendClaim(store, {
			project: "p",
			id: "W1",
			sid: "autowx",
			forMs: 45 * 60_000,
			note: "long build",
		});
		expect(ok.ok).toBe(true);
		expect(ok.until).toBeGreaterThan(Date.now());
		const ev = store
			.query("SELECT kind FROM events WHERE kind = 'work.extended'")
			.all();
		expect(ev.length).toBe(1);
	});
});

describe("sweepReclaims (executor-scoped, tri-state, ×3)", () => {
	test("local grant: dead repeats ×3 before the CAS release", () => {
		const store = seed([{ id: "W1", owner: "autowx", origin: EXEC }]);
		const verdict: "dead" | "live" | "unknown" = "dead";
		let released = 0;
		const run = () =>
			sweepReclaims(store, "p", {
				probe: () => verdict,
				release: () => {
					released++;
					return true;
				},
			});
		expect(run()[0]).toMatchObject({
			verdict: "dead",
			streak: 1,
			action: "held",
		});
		expect(run()[0]).toMatchObject({ streak: 2, action: "held" });
		expect(run()[0]).toMatchObject({
			streak: DEAD_REQUIRED,
			action: "released",
		});
		expect(released).toBe(1);
		// streak cleared after release — a re-taken claim starts at zero
		expect(run()[0]).toMatchObject({ streak: 1, action: "held" });
	});

	test("live and unknown never release; unknown resets the dead streak", () => {
		const store = seed([{ id: "W1", owner: "autowx", origin: EXEC }]);
		let verdict: "dead" | "live" | "unknown" = "dead";
		const run = () =>
			sweepReclaims(store, "p", { probe: () => verdict, release: () => true });
		run();
		verdict = "unknown";
		expect(run()[0]).toMatchObject({
			verdict: "unknown",
			streak: 0,
			action: "held",
		});
		verdict = "dead";
		expect(run()[0]).toMatchObject({ streak: 1, action: "held" });
		verdict = "live";
		expect(run()[0]).toMatchObject({ verdict: "live", streak: 0 });
		verdict = "dead";
		expect(run()[0]).toMatchObject({ streak: 1, action: "held" });
	});

	test("foreign grant: hb age only — fresh holds, stale ×3 releases, missing row never", () => {
		const store = seed([
			{ id: "W2", owner: "autowr", origin: "other-exec:claude" },
			{ id: "W4", owner: "autown", origin: "other-exec:claude" },
		]);
		let age: number | null = 10_000; // fresh
		const run = () =>
			sweepReclaims(store, "p", {
				now: NOW + 1,
				hbAge: (sid) => (sid === "autown" ? null : age),
				release: () => true,
			});
		expect(run()[0]).toMatchObject({
			id: "W2",
			verdict: "live",
			action: "held",
		});
		age = 3 * 60_000; // stale beyond the ≥2× hb-interval grace
		expect(run()[0]).toMatchObject({ id: "W2", verdict: "dead", streak: 1 });
		expect(run()[0]).toMatchObject({ streak: 2 });
		expect(run()[0]).toMatchObject({
			streak: DEAD_REQUIRED,
			action: "released",
		});
		// no heartbeat row: unknown — never reads as dead, any number of passes
		for (let i = 0; i < 5; i++)
			expect(run()[1]).toMatchObject({
				id: "W4",
				verdict: "unknown",
				action: "held",
			});
		// the unknown claim's streak stayed at zero the whole time
		expect(
			store
				.query("SELECT streak FROM claim_death_streaks WHERE id = 'W4'")
				.all(),
		).toEqual([]);
	});

	test("extended claim holds outright and resets the streak", () => {
		const store = seed([{ id: "W1", owner: "autowx", origin: EXEC }]);
		claimLivenessTables(store);
		store.run(
			"INSERT INTO claim_extends (project, id, until_ms, note, by_sid, at) VALUES ('p', 'W1', ?, 'why', 'autowx', ?)",
			NOW + 60_000,
			NOW,
		);
		const [v] = sweepReclaims(store, "p", {
			now: NOW + 1,
			probe: () => "dead",
			release: () => true,
		});
		expect(v).toMatchObject({ verdict: "extended", streak: 0, action: "held" });
		expect(
			store.query("SELECT COUNT(*) AS n FROM claim_death_streaks").get(),
		).toEqual({ n: 0 });
	});
});

describe("observeClaim routing (W613)", () => {
	test("foreign grant ignores local evidence — verdict by hb age only", () => {
		const store = seed([
			{ id: "W2", owner: "autowr", origin: "other-exec:claude" },
		]);
		expect(
			observeClaim(
				store,
				"p",
				row(store, "W2"),
				{ probe: () => "dead" },
				NOW + 1,
			),
		).toBe("unknown");
	});

	test("local grant takes the probe verdict", () => {
		const store = seed([{ id: "W1", owner: "autowx", origin: EXEC }]);
		expect(
			observeClaim(
				store,
				"p",
				row(store, "W1"),
				{ probe: () => "dead" },
				NOW + 1,
			),
		).toBe("dead");
	});
});

describe("executor identity (W613)", () => {
	test("executorId stable; sameExecutor normalizes only the .local flip", () => {
		expect(executorId()).toBe(executorId());
		expect(sameExecutor("MacBook-Pro.local", "MacBook-Pro.localdomain")).toBe(
			true,
		);
		expect(sameExecutor("MacBook-Pro.local", "nas.threads.dk")).toBe(false);
	});
});
