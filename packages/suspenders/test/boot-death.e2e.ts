// W2337 regression pins — boot-boundary death evidence for unknown-liveness
// claimants. The Oct 30 machine death left claims (W1294.9.1/W2173.1) whose
// claimant reads UNKNOWN forever: session row RUNNING with hb frozen
// pre-reboot, no lane-registry entry, no transcript. A reboot no process
// survives is POSITIVE death evidence when every stamp the registry holds
// (session started_at, lane launchedAt) provably pre-dates the current boot
// and no WS subscribe vouches. Lookup failure stays unknown (W51).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	bootEpoch,
	claimantPreBootDeath,
	predatesBoot,
	readSessionStamp,
	resetBootEpoch,
} from "../hooks/lib/lanes/boot-death.ts";
import { reclaimGateDecision } from "../hooks/lib/lanes/reclaim-sticky.ts";
import {
	observeReclaim,
	probeClaim,
} from "../hooks/lib/lanes/reclaim-liveness.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";

test.describe("@unit", () => {
	const databases: Database[] = [];
	test.afterEach(() => {
		for (const db of databases.splice(0)) db.close();
		resetBootEpoch();
	});

	const BOOT = {
		id: "044a87d4-50b8-4458-946a-77eb74da8f46",
		at: 1793388584000,
	};
	const PRE_BOOT = BOOT.at - 30 * 60_000;
	// a live REAL boot epoch on the host running the suite must never
	// classify a synthetic pre-boot stamp (clock skew safety in the probe:
	// `at < epoch.at` uses the machine's own numbers)
	const epoch = () => BOOT;

	function fixture(): GovernorStore {
		const db = new Database(":memory:");
		databases.push(db);
		db.run(
			"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')",
		);
		db.run(
			"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
		);
		return {
			local: true,
			query: (sql) => db.query(sql),
			run: (sql, ...params) => db.run(sql, ...(params as never[])),
			transaction: <T>(fn: () => T) => db.transaction(fn)(),
			close: () => db.close(),
		};
	}

	test("bootEpoch: observable on this machine (darwin) with an id and a finite at", () => {
		const e = bootEpoch();
		expect(e).not.toBe(null);
		expect(e?.id ?? "").toMatch(/^[a-f0-9-]{36}$/i);
		expect(Number.isFinite(e?.at ?? Number.NaN)).toBe(true);
	});

	test("predatesBoot: stamps before the boot bound; at/after never bound", () => {
		expect(predatesBoot(BOOT, PRE_BOOT)).toBe(true);
		expect(predatesBoot(BOOT, BOOT.at)).toBe(false);
		expect(predatesBoot(BOOT, BOOT.at + 1000)).toBe(false);
		expect(predatesBoot(BOOT, 0)).toBe(false);
	});

	test("pre-boot session + no registry row + no presence = dead, tagged", () => {
		const d = claimantPreBootDeath({
			sid: "autow1294",
			session: { started_at: PRE_BOOT, state: "RUNNING" },
			epoch: epoch(),
			presence: () => false,
		});
		expect(d?.dead).toBe(true);
		expect(d?.dead && d.why).toContain("claimant pre-dates boot");
		expect(d?.dead && d.why).toContain("044a87d4");
	});

	test("a session started AFTER the boot is not boot-dead (lookup miss, not death)", () => {
		const d = claimantPreBootDeath({
			sid: "autow1294",
			session: { started_at: BOOT.at + 60_000, state: "RUNNING" },
			epoch: epoch(),
			presence: () => false,
		});
		expect(d).toEqual({ dead: false, why: null });
	});

	test("WS subscribe presence vetoes boot death even on a pre-boot stamp", () => {
		const d = claimantPreBootDeath({
			sid: "autow1294",
			session: { started_at: PRE_BOOT, state: "RUNNING" },
			epoch: epoch(),
			presence: () => true,
		});
		expect(d).toEqual({ dead: false, why: null });
	});

	test("unobservable boot epoch is null — never death (W51)", () => {
		expect(
			claimantPreBootDeath({
				sid: "autow1294",
				session: { started_at: PRE_BOOT, state: "RUNNING" },
				epoch: null,
				presence: () => false,
			}),
		).toBe(null);
	});

	test("a foreign-host lane row never bounds the local boot", () => {
		const d = claimantPreBootDeath({
			sid: "autow1294",
			session: { started_at: PRE_BOOT, state: "RUNNING" },
			lane: { sid: "x", item: "W1", launchedAt: PRE_BOOT, host: "elsewhere" },
			epoch: epoch(),
			presence: () => false,
		});
		expect(d).toBe(null);
	});

	test("probeClaim: the Oct-30 wedge shape flips unknown → dead with boot evidence", () => {
		const s = fixture();
		s.run(
			"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES ('autow1294', 'p', 'lane', NULL, NULL, ?, ?, 'RUNNING')",
			PRE_BOOT,
			PRE_BOOT,
		);
		const p = probeClaim(s, "p", {
			id: "W1294.9.1",
			owner: "autow1294",
			revision: 1,
			bootEpoch: BOOT,
			wsPresence: () => false,
		});
		expect(p.verdict).toBe("dead");
		expect(p.deathEvidence).toContain("claimant pre-dates boot");
		// 3 strikes release — the bulk pass converges now
		const obs = {
			id: "W1294.9.1",
			owner: "autow1294",
			revision: 1,
			bootEpoch: BOOT,
			wsPresence: () => false,
		};
		expect(observeReclaim(s, "p", obs).why).toContain("strike 1/3");
		expect(observeReclaim(s, "p", obs).why).toContain("strike 2/3");
		const third = observeReclaim(s, "p", obs);
		expect(third.action).toBe("release");
		expect(third.why).toContain("claimant pre-dates boot");
	});

	test("probeClaim: post-boot session keeps the honest unknown (no wedge fix by clock accident)", () => {
		const s = fixture();
		s.run(
			"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES ('autow2', 'p', 'lane', NULL, NULL, ?, ?, 'RUNNING')",
			BOOT.at + 60_000,
			BOOT.at + 60_000,
		);
		const p = probeClaim(s, "p", {
			id: "W1",
			owner: "autow2",
			revision: 1,
			bootEpoch: BOOT,
			wsPresence: () => false,
		});
		expect(p.verdict).toBe("unknown");
		expect(p.deathEvidence).toBeUndefined();
	});

	test("readSessionStamp: row read + null on missing sid or broken store", () => {
		const s = fixture();
		expect(readSessionStamp(s, "")).toBe(null);
		s.run(
			"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES ('o9', 'p', 'lane', NULL, NULL, 5, 5, 'RUNNING')",
		);
		expect(readSessionStamp(s, "o9")).toEqual({
			started_at: 5,
			state: "RUNNING",
		});
		const broken = {
			local: true,
			query: () => {
				throw new Error("db locked");
			},
		} as unknown as GovernorStore;
		expect(readSessionStamp(broken, "o9")).toBe(null);
	});

	test("reclaim gate: forced crash reclaim proceeds on unknown ONLY with a justification", () => {
		// W2337: the wedge exit — unknown verdict, operator decision recorded
		expect(
			reclaimGateDecision("unknown", "crash", true, "machine died Oct 30").ok,
		).toBe(true);
		// force without justification still refuses
		expect(reclaimGateDecision("unknown", "crash", true).ok).toBe(false);
		expect(reclaimGateDecision("unknown", "crash", true, "  ").ok).toBe(false);
		// justification never rescues a LIVE claimant
		expect(
			reclaimGateDecision("alive", "crash", true, "machine died Oct 30").ok,
		).toBe(false);
	});
});
