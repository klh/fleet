// packages/blam/test/supervise.test.ts — supervisor coordination
// benchmark tests (W977.2): plane ledger behaviors, regime engine,
// matched comparison, bench properties.
import { describe, expect, test } from "bun:test";
import { CoordPlane, deliveryFailsFor } from "../bench/supervise/plane.ts";
import { runItem, runRegime } from "../bench/supervise/supervisors.ts";
import {
	REGIMES,
	type RegimeName,
	type SupervisorQueue,
} from "../bench/supervise/types.ts";
import {
	SCENARIOS,
	checkProperties,
	itemAccountingHolds,
	planeFor,
	queuesFor,
	runScenario,
} from "../bench/supervise/harness.ts";

describe("coordination plane", () => {
	test("claim is transactional: first wins, foreign refused", () => {
		const p = new CoordPlane({
			budget: 4,
			delivery: "ok",
			latencyMin: 4,
		});
		expect(p.claim("s1", "sh1").kind).toBe("claimed");
		expect(p.claim("s2", "sh1").kind).toBe("refused");
	});

	test("completed scopes refuse re-claims (backstop)", () => {
		const p = new CoordPlane({
			budget: 4,
			delivery: "ok",
			latencyMin: 4,
		});
		p.complete("s1", "sh1");
		expect(p.claim("s2", "sh1").kind).toBe("refused");
	});

	test("heldAt/nextFreeAt track leases", () => {
		const p = new CoordPlane({
			budget: 4,
			delivery: "ok",
			latencyMin: 4,
		});
		expect(p.heldAt(0)).toBe(0);
		p.acquire("s1", 2, 0, 30);
		expect(p.heldAt(29)).toBe(2);
		expect(p.nextFreeAt(10)).toBe(30);
		expect(p.heldAt(30)).toBe(0);
		expect(p.nextFreeAt(30)).toBe(0);
	});
});

describe("delivery health", () => {
	test("drop-first fails exactly the first ask per key", () => {
		const fails = deliveryFailsFor("drop-first");
		expect(fails("k", 1)).toBe(true);
		expect(fails("k", 2)).toBe(false);
		expect(fails("k", 3)).toBe(false);
	});

	test("drop-all fails every ask", () => {
		const fails = deliveryFailsFor("drop-all");
		expect(fails("k", 1)).toBe(true);
		expect(fails("k", 5)).toBe(true);
	});
});

describe("regime engine", () => {
	test("independent duplicates shared scopes, coordinated yields them", () => {
		const mk = (name: RegimeName) => {
			const plane = planeFor(SCENARIOS[0]);
			return runRegime({ plane, queues: queuesFor(false), spec: REGIMES[name] });
		};
		const ind = mk("independent");
		expect(ind.metrics.duplicateUnits).toBe(3);
		expect(ind.metrics.claimAttempts).toBe(0);
		const bnd = mk("coordinated-bounded");
		expect(bnd.metrics.duplicateUnits).toBe(0);
		expect(bnd.metrics.yieldedItems).toBe(3);
	});
});

describe("matched comparison", () => {
	test("P3: bounded asks strictly less than unbounded at outcome parity", () => {
		const CALM = SCENARIOS[0];
		const bnd = runScenario("coordinated-bounded", CALM).total;
		const unb = runScenario("coordinated-unbounded", CALM).total;
		expect(bnd.consultCalls).toBeLessThan(unb.consultCalls);
		expect(unb.duplicateUnits).toBe(0);
		expect(unb.claimConflicts).toBe(0);
	});

	test("P5: drop-all keeps correctness via the ledger backstop", () => {
		const da = runScenario("coordinated-bounded", SCENARIOS[3]).total;
		expect(da.duplicateUnits).toBe(0);
		expect(da.claimConflicts).toBeGreaterThanOrEqual(1);
	});
});

describe("bench properties", () => {
	test("all properties hold", () => {
		expect(checkProperties()).toEqual([]);
	});

	test("item accounting: no lost work in any arm × scenario", () => {
		for (const arm of [
			"independent",
			"coordinated-bounded",
			"coordinated-unbounded",
		] as const) {
			for (const cfg of SCENARIOS) {
				expect(itemAccountingHolds(arm, cfg)).toBe(true);
			}
		}
	});

	test("determinism: byte-identical metrics on rerun", () => {
		const a = JSON.stringify(runScenario("coordinated-bounded", SCENARIOS[0]));
		const b = JSON.stringify(runScenario("coordinated-bounded", SCENARIOS[0]));
		expect(a).toBe(b);
	});
});