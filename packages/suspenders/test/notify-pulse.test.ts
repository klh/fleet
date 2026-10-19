// test/notify-pulse.test.ts — W822: the fleet-pulse digest. Covers the
// notify.yaml pulse block (cadence + class), the composer (lanes, READY
// ages, DONE-since shas, watchdog, decisions, commits), the delta contract
// (heartbeat always, body only on change), firePulse state advancement, and
// the renderer's applyPulseInterval.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_PULSE_INTERVAL_S,
	normalizeConfig,
} from "../hooks/lib/notify.ts";
import {
	composePulse,
	firePulse,
	type PulseDeps,
	type PulseState,
	readWatchdog,
	savePulseState,
	loadPulseState,
} from "../hooks/lib/pulse.ts";
import {
	applyPulseInterval,
	loadManifest,
} from "../scripts/install-services.ts";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function mkStore(): Database {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE work_deps (project TEXT NOT NULL, work_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (project, work_id, depends_on))",
	);
	return db;
}

const item = (
	db: Database,
	id: string,
	state: string,
	created_at = T0,
	updated_at = created_at,
	result_sha: string | null = null,
): void => {
	db.run(
		"INSERT INTO work_items (project, id, title, state, created_at, updated_at, result_sha) VALUES ('p', ?, ?, ?, ?, ?, ?)",
		[id, `title ${id}`, state, created_at, updated_at, result_sha],
	);
};

const deps = (db: Database, work_id: string, depends_on: string): void => {
	db.run(
		"INSERT INTO work_deps (project, work_id, depends_on) VALUES ('p', ?, ?)",
		[work_id, depends_on],
	);
};

const baseDeps = (db: Database, over: Partial<PulseDeps> = {}): PulseDeps => ({
	store: db,
	project: "p",
	fleetRoot: "/nonexistent-fleet-root",
	registry: () => [],
	git: () => [],
	watchdog: () => ({ state: "ok", at: null }),
	...over,
});

describe("notify pulse config", () => {
	test("pulse.interval_s defaults to 14400; valid override wins; invalid falls back", () => {
		expect(normalizeConfig({}).pulse.interval_s).toBe(DEFAULT_PULSE_INTERVAL_S);
		expect(
			normalizeConfig({ pulse: { interval_s: 600 } }).pulse.interval_s,
		).toBe(600);
		expect(
			normalizeConfig({ pulse: { interval_s: "soon" } }).pulse.interval_s,
		).toBe(DEFAULT_PULSE_INTERVAL_S);
		expect(
			normalizeConfig({ pulse: { interval_s: 600 } }).pulse.interval_s,
		).toBe(600);
		expect(
			normalizeConfig({ pulse: { interval_s: -1 } }).pulse.interval_s,
		).toBe(DEFAULT_PULSE_INTERVAL_S);
	});
});

describe("pulse state", () => {
	test("round-trips and tolerates absent/corrupt files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pulse-state-"));
		const path = join(dir, "pulse-state.json");
		expect(loadPulseState(path)).toBeNull();
		const st: PulseState = { lastSentAt: T0, lastDigest: "d1x" };
		savePulseState(path, st);
		expect(loadPulseState(path)).toEqual(st);
		writeFileSync(path, "{not json");
		expect(loadPulseState(path)).toBeNull();
	});
});

describe("readWatchdog", () => {
	test("state json wins; aggregate log line is the fallback; absent = unknown", () => {
		const dir = mkdtempSync(join(tmpdir(), "pulse-wd-"));
		const fleet = join(dir, "fleet");
		mkdirSync(join(fleet, ".fleet"), { recursive: true });
		writeFileSync(
			join(fleet, ".fleet", "dispatch-watchdog.json"),
			JSON.stringify({
				at: "2026-10-19T10:00:00.000Z",
				health: { state: "stalled" },
			}),
		);
		expect(readWatchdog(fleet)).toEqual({
			state: "stalled",
			at: "2026-10-19T10:00:00.000Z",
		});
		rmSync(join(fleet, ".fleet", "dispatch-watchdog.json"));
		writeFileSync(
			join(fleet, ".fleet", "dispatch-watchdog.log"),
			"2026-10-19T09:00:00.000Z aggregate degraded | lane ok\n",
		);
		expect(readWatchdog(fleet)).toEqual({
			state: "degraded",
			at: "2026-10-19T09:00:00.000Z",
		});
		expect(readWatchdog(join(dir, "no-fleet"))).toEqual({
			state: "unknown",
			at: null,
		});
	});
});

describe("composePulse", () => {
	test("heartbeat renders lanes/READY/DEC/wd; DEC n/a without a decisions table", () => {
		const d = baseDeps(mkStore(), {
			registry: () => [
				{ sid: "a", item: "W1" },
				{ sid: "b", item: "W2" },
			],
			liveness: (l) => l.sid === "a",
		});
		const dg = composePulse(d);
		expect(dg.heartbeat).toContain("lanes 1/2");
		expect(dg.heartbeat).toContain("READY 0");
		expect(dg.heartbeat).toContain("DEC n/a");
		expect(dg.heartbeat).toContain("wd ok");
	});

	test("READY section: ages listed, items behind non-DONE deps gated out", () => {
		const db = mkStore();
		item(db, "R1", "READY", T0 - 2 * HOUR);
		item(db, "R2", "READY", T0 - 40 * HOUR);
		item(db, "P1", "CLAIMED", T0 - 2 * HOUR);
		deps(db, "R2", "P1");
		const dg = composePulse(baseDeps(db, { now: () => T0 }));
		expect(dg.heartbeat).toContain("READY 1");
		expect(dg.body).toContain("R1 2h");
		expect(dg.body).not.toContain("R2");
	});

	test("DONE-since lists items closed after state.lastSentAt with shas", () => {
		const db = mkStore();
		item(db, "R1", "READY", T0 - HOUR);
		item(db, "D1", "DONE", T0 - 3 * HOUR, T0 - HOUR, "abc12345");
		item(db, "D2", "DONE", T0 - 3 * HOUR, T0 - 5 * HOUR, "old99999");
		const dg = composePulse(
			baseDeps(db, {
				state: { lastSentAt: T0 - 2 * HOUR, lastDigest: "" },
			}),
		);
		expect(dg.body).toContain("D1 abc12345");
		expect(dg.body).not.toContain("D2");
	});

	test("delta contract: fresh state sends sections; matching digestKey sends heartbeat only", () => {
		const db = mkStore();
		item(db, "R1", "READY", T0 - 2 * HOUR);
		const first = composePulse(baseDeps(db, { now: () => T0 }));
		expect(first.deltas).toBeGreaterThan(0);
		expect(first.body).toContain("R1 2h");
		const again = composePulse(
			baseDeps(db, {
				now: () => T0,
				state: { lastSentAt: T0, lastDigest: first.digestKey },
			}),
		);
		expect(again.deltas).toBe(0);
		expect(again.body).toBe(again.heartbeat);
		expect(again.body).not.toContain("R1");
	});
});

describe("firePulse", () => {
	test("sends on class channels and advances state on first ok", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulse-fire-"));
		const statePath = join(dir, "pulse-state.json");
		const db = mkStore();
		item(db, "R1", "READY", T0 - 2 * HOUR);
		const sent: string[] = [];
		const res = await firePulse({
			...baseDeps(db),
			now: () => T0,
			config: normalizeConfig({
				channels: { desktop: { enabled: true } },
				classes: { pulse: { channels: ["desktop"] } },
			}),
			senders: {
				desktop: async (n) => {
					sent.push(n.body);
				},
			},
			statePath,
		});
		expect(res.channels.desktop).toBe("ok");
		expect(res.advanced).toBe(true);
		expect(sent[0]).toContain("R1 2h");
		expect(loadPulseState(statePath)).toEqual({
			lastSentAt: T0,
			lastDigest: res.digest.digestKey,
		});
	});

	test("a failing channel is isolated; zero deliveries never advance state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulse-fail-"));
		const statePath = join(dir, "pulse-state.json");
		const res = await firePulse({
			...baseDeps(mkStore()),
			now: () => T0,
			config: normalizeConfig({
				channels: { desktop: { enabled: true } },
				classes: { pulse: { channels: ["desktop"] } },
			}),
			senders: {
				desktop: async () => {
					throw new Error("osascript died");
				},
			},
			statePath,
		});
		expect(res.channels.desktop).not.toBe("ok");
		expect(res.advanced).toBe(false);
		expect(loadPulseState(statePath)).toBeNull();
	});
});

describe("applyPulseInterval", () => {
	test("fleet-pulse cadence rides notify.yaml pulse.interval_s; default when absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "pulse-int-"));
		const cfg = join(dir, "notify.yaml");
		writeFileSync(cfg, "pulse:\n  interval_s: 600\n");
		const tuned = applyPulseInterval(loadManifest(), cfg);
		expect(
			tuned.find((s) => s.name === "fleet-pulse")?.schedule?.intervalSeconds,
		).toBe(600);
		expect(
			tuned.find((s) => s.name === "board")?.schedule?.intervalSeconds,
		).toBeUndefined();
		const fallback = applyPulseInterval(
			loadManifest(),
			join(dir, "absent-notify.yaml"),
		);
		expect(
			fallback.find((s) => s.name === "fleet-pulse")?.schedule?.intervalSeconds,
		).toBe(DEFAULT_PULSE_INTERVAL_S);
	});
});
