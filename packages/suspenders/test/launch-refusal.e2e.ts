// launch-refusal.e2e.ts — W2317 (Kueue pattern 5): the ONE launch-refusal
// seam. Covers the pure classifier (Transient default, Permanent
// configuration/auth class, exit-125 fence contention), the failure exit's
// two effects (Transient backoff vs Permanent FAILED+NEED_DECISION), the
// launchFailureCatch adapter's evidence plumbing (W1165 appended bytes,
// never-launched attempts), and the bounded unknown-liveness re-probe
// (advance → exhaust → surface once, episode resets, capacity released).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	classifyLaunchRefusal,
	DEFAULT_REPROBE_MAX_ATTEMPTS,
	finishFailedLaunch,
	heldLaunchItems,
	heldLaunchReport,
	LaunchRefusalSchema,
	launchSchema,
	reserveLaunchIntent,
	RequeueSpecSchema,
	type LaunchIntent,
} from "../scripts/lib/launch-fencing.ts";
import {
	launchFailureCatch,
	launchFailureExit,
	unknownSurfaceGate,
	unknownSurfaceNote,
} from "../scripts/lib/launch-refusal.ts";

test.describe("@unit", () => {
	const probeIntent = (
		over: Partial<LaunchIntent> & { item: string },
	): LaunchIntent => ({
		project: "p",
		item: over.item,
		sid: over.sid ?? `auto-${over.item}`,
		nonce: over.nonce ?? "n1",
		revision: 1,
		executor: "/bin/true",
		host: over.host ?? "h",
		attempt: over.attempt ?? 0,
		state: over.state ?? "REGISTERED",
		pid: over.pid ?? null,
		birth: over.birth ?? null,
	});

	/** facts+events+intents store: reprobe episodes persist in facts. */
	function fixture() {
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
		);
		db.run(
			"CREATE TABLE events(id INTEGER PRIMARY KEY,ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
		);
		db.run(
			"CREATE TABLE work_items(project TEXT,id TEXT,owner_sid TEXT,updated_at INTEGER,state TEXT)",
		);
		db.run(
			"CREATE TABLE lane_launch_leases(project TEXT NOT NULL,sid TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(project,sid))",
		);
		db.run("INSERT INTO work_items VALUES ('p','W1','lane',100,'CLAIMED')");
		const store = db as unknown as GovernorStore;
		launchSchema(store);
		return { db, store };
	}

	test("classifier: Permanent is the configuration/auth class, everything else Transient", () => {
		expect(
			classifyLaunchRefusal({ code: "invalid-launch-or-auth" }),
		).toMatchObject({ disposition: "Permanent" });
		expect(
			classifyLaunchRefusal({
				code: "launch-exited",
				stderr: "error: unknown option '--sandbox'",
			}).disposition,
		).toBe("Permanent");
		expect(
			classifyLaunchRefusal({ code: "429", stderr: "HTTP 401 unauthorized" })
				.disposition,
		).toBe("Permanent");
		// provider backpressure, transport, upstream, quota: all retryable
		for (const code of [
			"429",
			"upstream-unavailable",
			"transport-unavailable",
			"launch-exited",
			"quota-exhausted",
		])
			expect(classifyLaunchRefusal({ code }).disposition).toBe("Transient");
		// unknown codes never deactivate work on a guess
		expect(
			classifyLaunchRefusal({ code: "some-new-fact-code" }).disposition,
		).toBe("Transient");
	});

	test("classifier: exit 125 is fence contention, never Permanent", () => {
		expect(
			classifyLaunchRefusal({ code: "launch-exited", exitCode: 125 }),
		).toMatchObject({ disposition: "Transient" });
		expect(
			classifyLaunchRefusal({
				code: "launch-exited",
				stderr: "Launch registration refused; harness was not started",
				exitCode: 125,
			}).disposition,
		).toBe("Transient");
	});

	test("schemas: the one refusal + requeue vocabulary validates", () => {
		expect(LaunchRefusalSchema.safeParse("Transient").success).toBe(true);
		expect(LaunchRefusalSchema.safeParse("Sometimes").success).toBe(false);
		expect(
			RequeueSpecSchema.safeParse({
				disposition: "Transient",
				requeueAt: 0,
				attempts: 0,
				maxAttempts: 3,
			}).success,
		).toBe(true);
		expect(
			RequeueSpecSchema.safeParse({
				disposition: "Transient",
				requeueAt: 1.5,
				attempts: -1,
				maxAttempts: 0,
			}).success,
		).toBe(false);
	});

	test("failure exit: Transient records backoff, never closes or surfaces", () => {
		const calls: string[] = [];
		const exit = launchFailureExit(
			"W1",
			{ appended: "HTTP 429 too many requests; Retry-After: 43", exitCode: 1 },
			1_000,
			{
				backoff: () => {
					calls.push("backoff");
					return { kind: "rate-limit", eligibleAt: 44_000 };
				},
				fail: () => {
					calls.push("fail");
					return { code: 0, out: "" };
				},
				surface: () => calls.push("surface"),
				log: () => calls.push("log"),
			},
		);
		expect(exit.verdict.disposition).toBe("Transient");
		expect(exit.closed).toBe(false);
		expect(exit.surfaced).toBe(false);
		expect(exit.backoff).toEqual({ kind: "rate-limit", eligibleAt: 44_000 });
		// the Transient effect fires exactly once (no double-record)
		expect(calls.filter((c) => c === "backoff")).toHaveLength(1);
		expect(calls).not.toContain("fail");
		expect(calls).not.toContain("surface");
	});

	test("failure exit: Permanent closes FAILED and surfaces one decision", () => {
		const calls: string[] = [];
		const notes: string[] = [];
		const exit = launchFailureExit(
			"W1",
			{ appended: "error: invalid api key rejected", exitCode: 1 },
			1_000,
			{
				backoff: () => {
					calls.push("backoff");
					return null;
				},
				fail: (note) => {
					calls.push(`fail:${note}`);
					return { code: 0, out: "ok" };
				},
				surface: (note) => {
					calls.push("surface");
					notes.push(note);
				},
				log: () => calls.push("log"),
			},
		);
		expect(exit.verdict.disposition).toBe("Permanent");
		expect(exit.closed).toBe(true);
		expect(exit.surfaced).toBe(true);
		expect(exit.backoff).toBeNull();
		expect(calls).not.toContain("backoff");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("W1");
		expect(notes[0]).toContain("operator");
	});

	test("failure exit: a close failure stays loud, never converts to retry", () => {
		const exit = launchFailureExit(
			"W1",
			{ appended: "invalid api key", exitCode: 1 },
			1_000,
			{
				backoff: () => null,
				fail: () => ({ code: 1, out: "not an unfinished claim" }),
				surface: () => {},
				log: () => {},
			},
		);
		expect(exit.verdict.disposition).toBe("Permanent");
		expect(exit.closed).toBe(false);
		// surfaced stays true: the decision is emitted even when the close
		// refused — the operator sees both facts
		expect(exit.surfaced).toBe(true);
	});

	test("catch adapter: a never-launched attempt classifies without evidence", () => {
		const { db, store } = fixture();
		try {
			const exit = launchFailureCatch(
				{ item: "W1", laneLog: "/absent.log", attempt: 0, logAtSpawn: 0, proc: undefined },
				{
					project: "p",
					sid: "lane",
					store,
					run: () => ({ code: 0, out: "" }),
					workCli: (...a: string[]) => a.join(" "),
					coordCli: (...a: string[]) => a.join(" "),
					log: () => {},
				},
			);
			// no process => no appended evidence => unknown/launch-exited => Transient
			expect(exit.verdict.disposition).toBe("Transient");
			expect(exit.backoff).toBeNull();
		} finally {
			db.close();
		}
	});

	test("catch adapter: a launched attempt's own bytes drive the classification", () => {
		const { db, store } = fixture();
		db.run(
			"INSERT INTO lane_launch_intents VALUES ('p','W1','lane','n1',1,'/bin/true','h',0,'REGISTERED',NULL,NULL)",
		);
		try {
			const events = () =>
				(
					db
						.query("SELECT count(*) AS n FROM events WHERE kind='lane.launch-backoff'")
						.get() as { n: number }
				).n;
			const exit = launchFailureCatch(
				{
					item: "W1",
					laneLog: "/absent-lane.log",
					attempt: 0,
					logAtSpawn: 0,
					proc: { exitCode: 1 },
				},
				{
					project: "p",
					sid: "lane",
					store,
					run: () => ({ code: 0, out: "" }),
					workCli: (...a: string[]) => a.join(" "),
					coordCli: (...a: string[]) => a.join(" "),
					log: () => {},
				},
			);
			// launched (exit defined) => the backoff ladder records — W1165: an
			// absent log reads empty, staying unknown/launch-exited => Transient
			expect(exit.verdict.disposition).toBe("Transient");
			expect(exit.backoff).not.toBeNull();
			expect(events()).toBe(1);
		} finally {
			db.close();
		}
	});

	test("re-probe: unknown liveness holds, then surfaces — never wedges the slot", () => {
		const { db, store } = fixture();
		db.run(
			"INSERT INTO lane_launch_intents VALUES ('p','W9','lane','n1',1,'/bin/true','h',0,'REGISTERED',999999,NULL)",
		);
		try {
			const inspect = () => "unknown" as const;
			// cycle 1: attempt 1 records (requeueAt = now+30s), held
			let report = heldLaunchReport(store, "p", 1_000, inspect);
			expect([...report.held]).toEqual(["W9"]);
			expect(report.surfaced).toEqual([]);
			// before the first requeueAt passes, further cycles do NOT burn attempts
			report = heldLaunchReport(store, "p", 5_000, inspect);
			expect([...report.held]).toEqual(["W9"]);
			// past each requeueAt the probe advances: 30s then 2m steps
			report = heldLaunchReport(store, "p", 31_000, inspect);
			expect([...report.held]).toEqual(["W9"]);
			report = heldLaunchReport(store, "p", 35_000, inspect);
			expect([...report.held]).toEqual(["W9"]);
			// the final advance exhausts the bound: surfaced, capacity RELEASED
			report = heldLaunchReport(store, "p", 151_000, inspect);
			expect([...report.held]).toEqual([]);
			expect(report.surfaced).toHaveLength(1);
			expect(report.surfaced[0]?.item).toBe("W9");
			expect(report.surfaced[0]?.justExhausted).toBe(true);
			expect(report.surfaced[0]?.attempts).toBe(DEFAULT_REPROBE_MAX_ATTEMPTS);
		} finally {
			db.close();
		}
	});

	test("re-probe: exhaustion surfaces exactly once per episode", () => {
		const { db, store } = fixture();
		db.run(
			"INSERT INTO lane_launch_intents VALUES ('p','W9','lane','n1',1,'/bin/true','h',0,'REGISTERED',999999,NULL)",
		);
		try {
			const emitted: string[] = [];
			const inspect = () => "unknown" as const;
			// burn the whole bound: attempts 1 (t=1s), 2 (t=31s), 3 (t=151s)
			heldLaunchReport(store, "p", 1_000, inspect);
			heldLaunchReport(store, "p", 31_000, inspect);
			let gate = unknownSurfaceGate(
				store,
				"p",
				(n) => emitted.push(n),
				() => {},
				151_000,
			);
			// the exhaustion emission rides the gate's own probe cycle
			expect(emitted).toHaveLength(1);
			expect(gate.surfaced[0]?.justExhausted).toBe(true);
			// subsequent cycles: still surfaced (capacity free) but NOT re-emitted
			gate = unknownSurfaceGate(
				store,
				"p",
				(n) => emitted.push(n),
				() => {},
				452_000,
			);
			expect(gate.surfaced).toHaveLength(1);
			expect(gate.surfaced[0]?.justExhausted).toBe(false);
			unknownSurfaceGate(
				store,
				"p",
				(n) => emitted.push(n),
				() => {},
				10_000_000,
			);
			expect(emitted).toHaveLength(1);
			expect(emitted[0]).toContain("W9");
			expect(emitted[0]).toContain("dispatch intent fail");
		} finally {
			db.close();
		}
	});

	test("re-probe: a proved-alive verdict resets the episode; reservation clears it", () => {
		const { db, store } = fixture();
		db.run(
			"INSERT INTO lane_launch_intents VALUES ('p','W1','lane','n1',100,'/bin/true','h',0,'REGISTERED',NULL,NULL)",
		);
		try {
			const as = (v: "alive" | "unknown") => () => v;
			// two unknown cycles advance the probe
			heldLaunchReport(store, "p", 1_000, as("unknown"));
			heldLaunchReport(store, "p", 31_000, as("unknown"));
			// alive resolves the episode (fact zeroed)
			let report = heldLaunchReport(store, "p", 32_000, as("alive"));
			expect([...report.held]).toEqual(["W1"]);
			// unknown again starts a FRESH episode at attempt 1 — still held
			report = heldLaunchReport(store, "p", 33_000, as("unknown"));
			expect([...report.held]).toEqual(["W1"]);
			expect(report.surfaced).toEqual([]);
			// a fresh reservation is a fresh episode too (proved-dead row replaced)
			db.run("UPDATE work_items SET updated_at=100");
			// reservation requires: dead prior intent + live lease + matching claim
			db.run("UPDATE lane_launch_intents SET state='FAILED' WHERE item='W1'");
			db.run(
				"INSERT INTO lane_launch_leases VALUES ('p','lane','n2',4102444800000)",
			);
			const intent = reserveLaunchIntent(
				store,
				{
					project: "p",
					item: "W1",
					sid: "lane",
					nonce: "n2",
					revision: 100,
					executor: "/usr/bin/true",
				},
				3,
			);
			expect(intent.state).toBe("PREPARING");
			// PREPARING + no pid => unknown => held, attempts back at 1
			report = heldLaunchReport(store, "p", 35_000, as("unknown"));
			expect([...report.held]).toEqual(["W1"]);
			expect(report.surfaced).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("re-probe: FAILED retires the episode and drops the slot", () => {
		const { db, store } = fixture();
		db.run(
			"INSERT INTO lane_launch_intents VALUES ('p','W1','lane','n1',1,'/bin/true','h',0,'REGISTERED',999999,NULL)",
		);
		try {
			const as = () => "unknown" as const;
			heldLaunchReport(store, "p", 1_000, as);
			finishFailedLaunch(store, probeIntent({ item: "W1", nonce: "n1" }));
			// FAILED rows never enter the held set (state filter) — and the
			// episode fact is gone, so a re-register starts clean
			const report = heldLaunchReport(store, "p", 2_000, as);
			expect([...report.held]).toEqual([]);
			expect(report.surfaced).toEqual([]);
			const leftover = db
				.query("SELECT count(*) AS n FROM facts WHERE key LIKE 'dispatch.intent-reprobe.%'")
				.get() as { n: number };
			expect(leftover.n).toBe(0);
		} finally {
			db.close();
		}
	});

	test("heldLaunchItems keeps its Set face over the report", () => {
		const { db, store } = fixture();
		db.run(
			"INSERT INTO lane_launch_intents VALUES ('p','W5','lane','n1',1,'/bin/true','h',0,'REGISTERED',NULL,NULL)",
		);
		try {
			// pid-less row inspects unknown through the REAL oracle: held
			expect([...heldLaunchItems(store, "p")]).toEqual(["W5"]);
		} finally {
			db.close();
		}
	});

	test("surface note names the operator door", () => {
		const note = unknownSurfaceNote({
			item: "W417",
			sid: "autow417-x",
			pid: 58349,
			attempts: 3,
			maxAttempts: 3,
			justExhausted: true,
		});
		expect(note).toContain("W417");
		expect(note).toContain("3/3");
		expect(note).toContain("58349");
		expect(note).toContain("dispatch intent fail --item W417");
	});
});
