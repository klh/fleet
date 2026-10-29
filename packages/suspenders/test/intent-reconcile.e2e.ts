// test/intent-reconcile.e2e.ts — W2262 regression: terminal-work launch
// intents with unknown liveness must stop holding admission slots after
// fenced reconciliation, while live and ambiguous nonterminal intents stay
// held. Incident 2026-10-29: ten REGISTERED unknown-liveness rows for DONE
// items consumed heldSlots and refused urgent dispatch at 7/8 with no active
// lane. Also pins the W2260 no-blanket-reclaim bound: an intent whose
// process verdict is ALIVE is never failed, whatever the work state says —
// claimant-liveness contradictions belong to the reclaim path, not here.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	heldLaunchItems,
	launchSchema,
	type LaunchIntent,
} from "../scripts/lib/launch-fencing.ts";
import { acquireLaunchLease } from "../scripts/lib/launch-preflight.ts";
import {
	reconcileTerminalLaunchIntents,
	TERMINAL_WORK_STATES,
} from "../scripts/lib/intent-reconcile.ts";
import {
	MAINTENANCE_TASKS,
	suspendersRoot,
} from "../hooks/lib/fleet-loop/maintenance.ts";

const unknown = (): "unknown" => "unknown";
const alive = (): "alive" => "alive";

test.describe("@unit", () => {
	const databases: Database[] = [];
	test.afterEach(() => {
		for (const db of databases.splice(0)) db.close();
	});

	// minimal fixture: work_items + lane_launch_intents + events, mirroring
	// launch-fencing.test.ts's in-memory shape
	function fixture() {
		const db = new Database(":memory:");
		databases.push(db);
		db.run(
			"CREATE TABLE work_items(project TEXT,id TEXT,owner_sid TEXT,updated_at INTEGER,state TEXT, PRIMARY KEY(project,id))",
		);
		db.run(
			"CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
		);
		const store = db as unknown as GovernorStore;
		launchSchema(store);
		acquireLaunchLease(store, "project", "lane", "nonce");
		return { db, store };
	}
	// a foreign-host REGISTERED row is the incident's exact shape: unknown
	// liveness (never provably dead) under the real inspector
	function plant(store: GovernorStore, item: string, workState: string) {
		store
			.query(
				"INSERT INTO work_items VALUES (?,?,NULL,100,?) ON CONFLICT(project,id) DO UPDATE SET state=excluded.state",
			)
			.run("project", item, workState);
		const row: LaunchIntent = {
			project: "project",
			item,
			sid: `lane-${item}`,
			nonce: `nonce-${item}`,
			revision: 100,
			executor: process.execPath,
			host: "some-other-host",
			attempt: 0,
			state: "REGISTERED",
			pid: 4242,
			birth: "boot:1",
		};
		store
			.query("INSERT INTO lane_launch_intents VALUES (?,?,?,?,?,?,?,?,?,?,?)")
			.run(
				row.project,
				row.item,
				row.sid,
				row.nonce,
				row.revision,
				row.executor,
				row.host,
				row.attempt,
				row.state,
				row.pid,
				row.birth,
			);
		return row;
	}
	const intentState = (store: GovernorStore, item: string): string =>
		(
			store
				.query("SELECT state FROM lane_launch_intents WHERE item=?")
				.get(item) as { state: string }
		).state;

	test("DONE + unknown stale intent is failed once, stops holding, and audits", () => {
		const { db, store } = fixture();
		plant(store, "W1", "DONE");
		plant(store, "W2", "READY");
		// pre-condition: the incident's phantom slot is already gone from
		// admission math (the heldLaunchItems terminal-work guard) — but the
		// ROW itself is still REGISTERED until the fenced reconcile flips it
		expect([...heldLaunchItems(store, "project")]).toEqual(["W2"]);
		expect(intentState(store, "W1")).toBe("REGISTERED");
		// dry-run reports, flips nothing
		const dry = reconcileTerminalLaunchIntents({
			store,
			project: "project",
			inspect: unknown,
		});
		expect(dry.failed.map((r) => r.item)).toEqual(["W1"]);
		expect(intentState(store, "W1")).toBe("REGISTERED");
		// act: CAS flip + immutable audit event
		const report = reconcileTerminalLaunchIntents({
			store,
			project: "project",
			act: true,
			inspect: unknown,
		});
		expect(report.scanned).toBe(2);
		expect(report.failed.map((r) => r.item)).toEqual(["W1"]);
		expect(report.skippedAmbiguous).toBe(1);
		expect(intentState(store, "W1")).toBe("FAILED");
		const audit = db
			.query(
				"SELECT payload FROM events WHERE kind='dispatch.intent.stale-failed' AND scope='W1'",
			)
			.get() as { payload: string };
		expect(JSON.parse(audit.payload).liveness).toBe("unknown");
		// post-condition: admission math frees the slot — a new READY item no
		// longer competes with a phantom (the supervise/dispatch-next shape)
		expect([...heldLaunchItems(store, "project")]).toEqual(["W2"]);
	});

	test("every terminal work state reconciles; READY/CLAIMED never do", () => {
		const { store } = fixture();
		for (const state of TERMINAL_WORK_STATES)
			plant(store, `T-${state}`, state);
		plant(store, "N-READY", "READY");
		plant(store, "N-CLAIMED", "CLAIMED");
		const report = reconcileTerminalLaunchIntents({
			store,
			project: "project",
			act: true,
			inspect: unknown,
		});
		expect(report.failed.map((r) => r.item).sort()).toEqual(
			TERMINAL_WORK_STATES.map((s) => `T-${s}`).sort(),
		);
		expect(report.skippedAmbiguous).toBe(2);
		// the nonterminal rows stay REGISTERED even under dead liveness —
		// claim ambiguity belongs to the reclaim path, never this sweep
		expect(intentState(store, "N-READY")).toBe("REGISTERED");
		expect(intentState(store, "N-CLAIMED")).toBe("REGISTERED");
		expect([...heldLaunchItems(store, "project")].sort()).toEqual([
			"N-CLAIMED",
			"N-READY",
		]);
	});

	test("W2260 bound: an ALIVE process verdict is never failed, even for DONE work", () => {
		const { store } = fixture();
		plant(store, "W1", "DONE");
		const report = reconcileTerminalLaunchIntents({
			store,
			project: "project",
			act: true,
			inspect: alive,
		});
		expect(report.failed).toEqual([]);
		expect(report.skippedLive).toBe(1);
		expect(intentState(store, "W1")).toBe("REGISTERED");
		// no blanket reclaim: nothing was flipped, nothing audited, and the
		// claim itself (work_items) was never touched — claimant-liveness
		// contradictions belong to the reclaim path, never this sweep
		expect(
			(
				store
					.query(
						"SELECT COUNT(*) AS n FROM events WHERE kind='dispatch.intent.stale-failed'",
					)
					.get() as { n: number }
			).n,
		).toBe(0);
		expect(
			store.query("SELECT state FROM work_items WHERE id='W1'").get(),
		).toEqual({ state: "DONE" });
	});

	test("CAS teeth: a work item that left terminal state mid-sweep is not failed", () => {
		const { store } = fixture();
		plant(store, "W1", "DONE");
		// the claimant re-claimed between the sweep's snapshot read and the
		// flip: workState returns the STALE terminal verdict while the table
		// already says CLAIMED — the CAS's work_items EXISTS guard must refuse
		store.query("UPDATE work_items SET state='CLAIMED' WHERE id='W1'").run();
		const report = reconcileTerminalLaunchIntents({
			store,
			project: "project",
			act: true,
			inspect: unknown,
			workState: () => "DONE",
		});
		expect(report.failures).toEqual([
			"W1: intent row changed during reconcile; left untouched",
		]);
		expect(intentState(store, "W1")).toBe("REGISTERED");
		// re-claimed: its intent keeps holding (nonterminal, unknown liveness)
		expect([...heldLaunchItems(store, "project")]).toEqual(["W1"]);
	});

	test("heartbeat owns the reconcile automatically (registry + runner)", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "intent-reconcile");
		expect(task?.everySeconds).toBe(600);
		expect(existsSync(task?.argv(suspendersRoot(), "/")[0] ?? "")).toBe(true);
	});
});
