// test/quota-lift-retry.test.ts — W804/W782.1: the heartbeat-carried requeue
// for quota-walled FAILED items (W738 opus leg — since W782.1 the full
// Copilot-quota triplet W738/W695.6.2/W731). Covers the gate-date parse,
// the comma-set item parse, the state/date gate matrix (missing /
// self-retired / waiting / requeued), the retry side effects (state flip +
// work.requeued emit), and the registry arming itself: the W779 task must
// stay registered with the triplet's gate or the mission silently disarms.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	gateMs,
	parseQuotaItems,
	quotaLiftRetry,
} from "../hooks/lib/quota-lift-retry.ts";
import {
	MAINTENANCE_TASKS,
	missingRunners,
	suspendersRoot,
} from "../hooks/lib/fleet-loop/maintenance.ts";
import { launchSchema } from "../scripts/lib/launch-fencing.ts";

function fixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, updated_at INTEGER)",
	);
	db.run("CREATE TABLE claims(sid TEXT, scope TEXT, intent TEXT)");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	db.run(
		"INSERT INTO work_items VALUES ('project','W1','FAILED','lane','s',100)",
	);
	db.run("INSERT INTO claims VALUES ('lane','s','W1 anything')");
	launchSchema(db as unknown as GovernorStore);
	return db as unknown as GovernorStore;
}

describe("gateMs", () => {
	test("parses YYYY-MM-DD to local midnight", () => {
		const d = new Date(gateMs("2026-11-01"));
		expect(d.getFullYear()).toBe(2026);
		expect(d.getMonth()).toBe(10);
		expect(d.getDate()).toBe(1);
		expect(d.getHours()).toBe(0);
	});

	test("malformed gate dates throw (usage error, not a silent skip)", () => {
		expect(() => gateMs("november")).toThrow();
		expect(() => gateMs("2026-11-01T10:00")).toThrow();
	});
});

describe("parseQuotaItems", () => {
	test("splits the comma-set, trims each id, drops empties", () => {
		expect(parseQuotaItems("W738,W695.6.2,W731")).toEqual([
			"W738",
			"W695.6.2",
			"W731",
		]);
	});

	test("single id round-trips (the W804 shape survives)", () => {
		expect(parseQuotaItems("W738")).toEqual(["W738"]);
	});

	test("blank segments and surrounding whitespace are dropped", () => {
		expect(parseQuotaItems(" W738 , ,W731 ")).toEqual(["W738", "W731"]);
	});
});

describe("quotaLiftRetry verdicts", () => {
	const GATE = "2026-11-01";
	const before = gateMs(GATE) - 1000;
	const at = gateMs(GATE);
	const call = (store: GovernorStore, nowMs: number, emit?: () => void) =>
		quotaLiftRetry({
			store,
			project: "project",
			id: "W1",
			gate: GATE,
			nowMs,
			emit,
		});

	test("missing item is a hard failure, never a silent skip", () => {
		const r = quotaLiftRetry({
			store: fixture(),
			project: "project",
			id: "W404",
			gate: GATE,
			nowMs: at,
		});
		expect(r.ok).toBe(false);
		expect(r.action).toBe("missing");
	});

	test("non-FAILED states self-retire the armed task (ok, no-op)", () => {
		const store = fixture();
		store.run("UPDATE work_items SET state='DONE' WHERE id='W1'");
		const r = call(store, at);
		expect(r).toEqual({
			ok: true,
			action: "noop",
			detail: expect.stringContaining("self-retired"),
		});
		expect(r.detail).toContain("DONE");
	});

	test("FAILED before the gate waits — the item is untouched", () => {
		const store = fixture();
		const r = call(store, before);
		expect(r.action).toBe("waiting");
		const it = store
			.query("SELECT state FROM work_items WHERE id='W1'")
			.get() as { state: string };
		expect(it.state).toBe("FAILED");
	});

	test("FAILED at/after the gate requeues: state flip + work.requeued emit", () => {
		const store = fixture();
		const emits: string[] = [];
		for (const nowMs of [at, at + 86_400_000]) {
			const s = nowMs === at ? store : fixture();
			const r = call(s, nowMs, (kind, note) => {
				emits.push(`${kind}|${note.startsWith("W1 ")}`);
			});
			expect(r.action).toBe("requeued");
			const it = s
				.query("SELECT state, owner_sid FROM work_items WHERE id='W1'")
				.get() as { state: string; owner_sid: string | null };
			expect(it.state).toBe("READY");
			expect(it.owner_sid).toBeNull();
		}
		expect(emits).toEqual([
			"work.requeued|true",
			"work.requeued|true",
		]);
	});
});

describe("W804 registry arming (the task must stay registered)", () => {
	test("quota-lift-retry is registered with the W738 gate and its runner resolves", () => {
		const task = MAINTENANCE_TASKS.find((t) => t.name === "quota-lift-retry");
		expect(task).toBeDefined();
		expect(task?.calendar).toEqual({ hour: 9, minute: 0 });
		expect(task?.argv(suspendersRoot(), "/")).toEqual([
			expect.stringContaining("quota-lift-retry.ts"),
			"--item",
			"W738,W695.6.2,W731",
			"--after",
			"2026-11-01",
		]);
		expect(missingRunners()).toEqual([]);
	});
});
