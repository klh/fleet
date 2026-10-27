// test/lifecycle-read-model.test.ts — W1312: the joined lane-lifecycle
// query surface + durable gap/drop counters. Projection edges LEFT JOIN
// the ledger on rid (both halves, projection-only, ledger degradation),
// attemptsAgree flags count drift, and gaps = emitted − observed per
// observer source (rotation/overflow/crash loss — never inferred away).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import type { Observation } from "../src/observe.ts";
import {
	type LifecycleQuery,
	lifecycleLoss,
	lifecycleSnapshot,
} from "../src/lifecycle-read-model.ts";
import { LaneProjection } from "../src/projection.ts";

const tmpDir = (): string => mkdtempSync(join(tmpdir(), "lifecycle-"));

const edgeEvent = (
	source: string,
	id: number,
	data: Record<string, unknown>,
	outcome: string | null,
): Observation => ({
	specversion: "1.0",
	type: outcome === null ? "lane.request.admitted" : "lane.request.ended",
	source,
	id: String(id),
	time: new Date().toISOString(),
	data: { ...data, ...(outcome === null ? {} : { outcome, status: 200 }) },
});

/** Project a full lifecycle for one rid (+ optional gap: skip a seq). */
const seedEdges = (
	proj: LaneProjection,
	rid: string,
	lane: string,
	outcome: string | null,
): void => {
	const base = { rid, lane, actor: "k1", model: "m1", dialect: "openai" };
	proj.ingest([edgeEvent("S1", ++seq, base, null)]);
	if (outcome !== null)
		proj.ingest([
			edgeEvent("S1", ++seq, { ...base, attempts: 2 }, outcome),
		]);
};
let seq = 0;

const seedLedger = (led: Ledger, rid: string, attempts: number | null): void => {
	led.auditDecision({
		rid,
		ts: new Date().toISOString(),
		actor: "k1",
		lane: "L1",
		dialect: "openai",
		hint: "",
		candidates_seen: 1,
		candidates_top: "m1",
		target_kind: "cloud",
		target_host: "api.example.test",
		target_port: 443,
		target_model: "m1",
		decision: "route",
		latency_class: "unproven",
		tier: "",
		allow_cloud: true,
		why: "",
		hop: "origin",
	});
	led.auditOutcome(rid, {
		status: attempts === null ? 503 : 200,
		duration_ms: 10,
		ok: attempts !== null,
		err: attempts === null ? "exhausted" : null,
		attempts,
	});
};

describe("lifecycleSnapshot", () => {
	test("joins both halves; attemptsAgree pins match and drift", () => {
		const dir = tmpDir();
		try {
			const proj = new LaneProjection(join(dir, "obs.db"));
			seedEdges(proj, "r-both", "L1", "ok"); // ledger attempts 2 = edge 2
			seedEdges(proj, "r-drift", "L2", "ok"); // ledger attempts 5 ≠ edge 2
			seedEdges(proj, "r-proj-only", "L3", "ok"); // no ledger row
			proj.close();
			const led = new Ledger(join(dir, "buckle.db"));
			seedLedger(led, "r-both", 2);
			seedLedger(led, "r-drift", 5);
			led.close();
			const snap = lifecycleSnapshot({
				obsDb: join(dir, "obs.db"),
				ledger: join(dir, "buckle.db"),
			});
			const byRid = new Map(snap.rows.map((r) => [r.rid, r]));
			const both = byRid.get("r-both");
			expect(both?.ledgerOk).toBe(1);
			expect(both?.targetHost).toBe("api.example.test");
			expect(both?.attemptsAgree).toBe(true);
			const drift = byRid.get("r-drift");
			expect(drift?.ledgerAttempts).toBe(5);
			expect(drift?.edgeAttempts).toBe(2);
			expect(drift?.attemptsAgree).toBe(false);
			const projOnly = byRid.get("r-proj-only");
			expect(projOnly?.ledgerTs).toBeNull();
			expect(projOnly?.attemptsAgree).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("filters: lane, errorOnly, ledgerMatch; absent ledger degrades to projection-only", () => {
		const dir = tmpDir();
		try {
			const proj = new LaneProjection(join(dir, "obs.db"));
			seedEdges(proj, "r-ok", "L1", "ok");
			seedEdges(proj, "r-err", "L1", "errored");
			proj.close();
			const paths = { obsDb: join(dir, "obs.db") };
			const byLane = lifecycleSnapshot(paths, { lane: "L1" });
			expect(byLane.rows).toHaveLength(2);
			const errs = lifecycleSnapshot(paths, { errorOnly: true });
			expect(errs.rows.map((r) => r.rid)).toEqual(["r-err"]);
			const noLedger = lifecycleSnapshot(paths, {
				ledgerMatch: "matched",
			});
			expect(noLedger.rows).toHaveLength(0);
			const un = lifecycleSnapshot(paths, { ledgerMatch: "unmatched" });
			expect(un.rows).toHaveLength(2);
			const degraded = lifecycleSnapshot({
				obsDb: join(dir, "obs.db"),
				ledger: join(dir, "missing.db"),
			});
			expect(degraded.rows).toHaveLength(2);
			expect(degraded.rows[0]?.ledgerOk).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("lifecycleLoss", () => {
	test("gaps = emitted − observed per source; absent db = no rows", () => {
		const dir = tmpDir();
		try {
			const proj = new LaneProjection(join(dir, "obs.db"));
			// S1 emits seq 1..3 but only 1 and 3 project (2 lost — the ingest
			// treats the jump as a gap and reconciles, both rows still land)
			proj.ingest([
				edgeEvent("S1", 1, { rid: "a", lane: "L" }, null),
				edgeEvent("S1", 3, { rid: "b", lane: "L" }, null),
			]);
			proj.ingest([edgeEvent("S2", 1, { rid: "c", lane: "L" }, null)]);
			proj.close();
			const loss = lifecycleLoss(join(dir, "obs.db"));
			expect(loss).toHaveLength(2);
			const s1 = loss.find((l) => l.source === "S1");
			expect(s1?.emitted).toBe(3);
			expect(s1?.observed).toBe(2);
			expect(s1?.gaps).toBe(1);
			const s2 = loss.find((l) => l.source === "S2");
			expect(s2?.gaps).toBe(0);
			expect(lifecycleLoss(join(dir, "nope.db"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

export type { LifecycleQuery };
