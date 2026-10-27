// test/decant-daily-roll.test.ts — W1220: the decant daily's upward
// dual-write post-pass (hooks/lib/decant-roll.ts). Acceptance: the daily run
// leaves local facts intact AND the roll lands on the sink; a same-day rerun
// pushes zero new rows; a sink outage logs (roll.errors) and never fails the
// local run.
import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaily } from "../hooks/lib/fleet-loop/decant-daily.ts";
import { pushDailyRoll } from "../hooks/lib/decant-roll.ts";
import { collectClaims } from "../hooks/lib/knowledge/knowledge-roll.ts";
import { readSyncState } from "../hooks/lib/knowledge/knowledge-sync.ts";
import { readState } from "../hooks/lib/fleet-loop/decant-daily.ts";

const tmp = mkdtempSync(join(tmpdir(), "w1220-roll-"));
const NOW = Date.now();
const SETTER = "mechanical:decant-daily";

test.afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Fixture facts db: two decant.claim.* rows (fresh + retracted) + one
 *  claim.* row — the bridge covers both namespaces. */
function claimFixtureDb(path: string): string {
	const db = new Database(path);
	db.exec(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL, confidence REAL, confidence_stamp TEXT)",
	);
	const stamp = (verdict: string, evidence: string): string =>
		JSON.stringify({
			value: 0.4,
			setter: SETTER,
			verdict,
			evidence,
			ts: NOW,
		});
	db.query("INSERT INTO facts VALUES (?, ?, 'decant-daily', 1, ?, 0.4, ?)").run(
		"decant.claim.aaa1",
		"done work item W1 → sha sha-W1",
		NOW - 60_000,
		stamp("fresh", "work:W1"),
	);
	db.query("INSERT INTO facts VALUES (?, ?, 'decant-daily', 2, ?, 0.4, ?)").run(
		"decant.claim.bbb2",
		"done work item W2 → sha sha-W2",
		NOW - 30_000,
		stamp("retracted", "work:W2"),
	);
	db.query("INSERT INTO facts VALUES (?, ?, 'sync', 1, ?, NULL, NULL)").run(
		"claim.ccc3",
		"plain claim row still rolls",
		NOW - 20_000,
	);
	db.close();
	return path;
}

/** Loopback roll receiver: records every landed roll (entries + the roll
 *  key header) and answers the ack the test set. */
function rollReceiver() {
	const got: { entries: unknown[]; auth: string | null }[] = [];
	const goodAck = (s: number) => ({
		ok: true,
		counts: {
			merged: s,
			versions: 0,
			tombstoned: 0,
			stale: 0,
			dupes: 0,
		},
	});
	let ackBody: (sent: number) => unknown = goodAck;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const p = (await req.json()) as { claims: unknown[] };
			got.push({
				entries: p.claims,
				auth: req.headers.get("x-klh-roll-key"),
			});
			return Response.json(ackBody(p.claims.length));
		},
	});
	return {
		got,
		url: `http://127.0.0.1:${server.port}`,
		setAck: (b?: (sent: number) => unknown) => {
			ackBody = b ?? goodAck;
		},
		stop: () => server.stop(true),
	};
}

/** landed entries flattened across pushes, typed for the assertions. */
const flatOf = (rx: ReturnType<typeof rollReceiver>) =>
	rx.got.flatMap((g) => g.entries) as {
		evidenceId: string;
		tombstone?: boolean;
	}[];

/** 0600 machine-conf fixture: one roll target (the receiver) + policy
 *  claims-only; state path beside it. */
function confFixture(
	dir: string,
	url: string,
): { cfgPath: string; statePath: string } {
	const keyPath = join(dir, "roll-key.secret");
	writeFileSync(keyPath, "klhroll-w1220-fake-value", { mode: 0o600 });
	const cfgPath = join(dir, "knowledge-sync.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			localHub: "w1220-devbox",
			targets: [
				{
					url,
					writeTokenFile: join(dir, "hub.token"),
					rollUrl: url,
					rollKeyFile: keyPath,
				},
			],
			policy: {
				metrics: false,
				metricsSessions: false,
				facts: false,
				claims: true,
			},
			decantBin: "decant",
		}),
		{ mode: 0o600 },
	);
	return { configPath: cfgPath, statePath: join(dir, "state.json") };
}

test.describe("collectClaims namespace bridge (W1220)", () => {
	test("decant.claim.* rows roll; retracted stamp → tombstone; claim.* still rolls", () => {
		const dir = join(tmp, "bridge");
		mkdirSync(dir);
		const out = collectClaims(
			{},
			{ dbPath: claimFixtureDb(join(dir, "g.db")) },
		);
		const byId = new Map(out.send.map((e) => [e.evidenceId, e]));
		expect(byId.get("work:W1")?.claim).toContain("done work item W1");
		expect(byId.get("work:W2")?.tombstone).toBe(true);
		expect(byId.get("ccc3")?.tombstone).toBe(false);
		expect(out.cursor["decant.claim.aaa1"]).toBe(1);
	});
});

test.describe("pushDailyRoll (W1220)", () => {
	test("no machine conf → disabled, ok, zero network", async () => {
		const dir = join(tmp, "noconf");
		mkdirSync(dir);
		const dbPath = claimFixtureDb(join(dir, "g.db"));
		const res = await pushDailyRoll({
			configPath: join(dir, "absent.json"),
			statePath: join(dir, "state.json"),
			dbPath,
		});
		expect(res.ok).toBe(true);
		expect(res.disabled).toBe(true);
		expect(res.sent).toBe(0);
	});

	test("claims roll to the sink; cursor stamps; same-day rerun pushes zero", async () => {
		const dir = join(tmp, "push");
		mkdirSync(dir);
		const rx = rollReceiver();
		const { configPath, statePath } = confFixture(dir, rx.url);
		const base = {
			configPath,
			statePath,
			dbPath: claimFixtureDb(join(dir, "g.db")),
		};
		const r1 = await pushDailyRoll(base);
		expect(r1.pushed).toBe(true);
		expect(r1.sent).toBe(3);
		expect(r1.targets).toEqual([rx.url]);
		expect(rx.got[0]?.auth).toBe("klhroll-w1220-fake-value");
		// the key header rides; evidence ids are the STAMP's, not the hash
		expect(
			flatOf(rx)
				.map((e) => e.evidenceId)
				.sort(),
		).toEqual(["ccc3", "work:W1", "work:W2"]);
		const st = readSyncState(statePath);
		expect(Object.keys(st.claims).sort()).toEqual([
			"claim.ccc3",
			"decant.claim.aaa1",
			"decant.claim.bbb2",
		]);
		const hits = rx.got.length;
		const r2 = await pushDailyRoll(base);
		expect(r2.sent).toBe(0); // same-day rerun: zero new rows
		expect(rx.got.length).toBe(hits);
		rx.stop();
	});

	test("retraction crosses as a tombstone event (no sink zombie)", async () => {
		const dir = join(tmp, "tomb");
		mkdirSync(dir);
		const rx = rollReceiver();
		const { configPath, statePath } = confFixture(dir, rx.url);
		const r = await pushDailyRoll({
			configPath,
			statePath,
			dbPath: claimFixtureDb(join(dir, "g.db")),
		});
		expect(r.pushed).toBe(true);
		const flat = flatOf(rx);
		expect(flat.find((e) => e.evidenceId === "work:W2")?.tombstone).toBe(true);
		expect(flat.find((e) => e.evidenceId === "work:W1")?.tombstone).toBe(false);
		rx.stop();
	});

	test("non-ack ({ok:false}) retains the cursor — the retry re-sends", async () => {
		const dir = join(tmp, "nonack");
		mkdirSync(dir);
		const rx = rollReceiver();
		rx.setAck(() => ({ ok: false, error: "invalid claim entry" }));
		const { configPath, statePath } = confFixture(dir, rx.url);
		const base = {
			configPath,
			statePath,
			dbPath: claimFixtureDb(join(dir, "g.db")),
		};
		const r1 = await pushDailyRoll(base);
		expect(r1.ok).toBe(false);
		expect(r1.pushed).toBe(false);
		expect(r1.errors[0]).toContain("invalid claim entry");
		expect(Object.keys(readSyncState(statePath).claims)).toEqual([]);
		// the retry (the ack healthy again) lands the SAME batch
		rx.setAck();
		const r2 = await pushDailyRoll(base);
		expect(r2.pushed).toBe(true);
		expect(r2.sent).toBe(3);
		rx.stop();
	});

	test("sink outage: logged, cursor retained, the pass fails open", async () => {
		const dir = join(tmp, "outage");
		mkdirSync(dir);
		const rx = rollReceiver();
		const { configPath, statePath } = confFixture(dir, rx.url);
		rx.stop(); // the sink goes dark before the pass
		const r = await pushDailyRoll({
			configPath,
			statePath,
			dbPath: claimFixtureDb(join(dir, "g.db")),
		});
		expect(r.ok).toBe(false);
		expect(r.pushed).toBe(false);
		expect(r.sent).toBe(3);
		expect(r.errors.length).toBeGreaterThan(0); // the log evidence
		expect(Object.keys(readSyncState(statePath).claims)).toEqual([]);
	});
});

/** decant CLI stub: `sync -q` ok; `ls --json` returns one fresh session. */
function writeDecantStub(dir: string): string {
	const bin = join(dir, "decant-stub.ts");
	writeFileSync(
		bin,
		`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "sync") process.exit(0);
if (a[0] === "ls") {
  const rows = [{ source_session_id: "s1", tool: "claude", model: "glm",
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date(Date.now() - 30000).toISOString(),
    message_count: 4, total_input_tokens: 10, total_output_tokens: 20 }];
  process.stdout.write(JSON.stringify(rows));
}
`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

/** work store + facts db: one DONE row (the daily distills it) and the
 *  claim the daily's coord child WOULD have landed (the roll's source). */
function seedDailyDb(path: string): void {
	const db = new Database(path);
	db.exec(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, result_sha TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id));" +
			"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER, confidence REAL, confidence_stamp TEXT);",
	);
	db.query(
		"INSERT INTO work_items (project, id, title, state, result_sha, updated_at) VALUES ('p', 'W1', 'done work item W1', 'DONE', 'sha-W1', ?)",
	).run(NOW - 3600_000);
	const stamp = JSON.stringify({
		value: 0.4,
		setter: SETTER,
		verdict: "fresh",
		evidence: "work:W1",
		ts: NOW,
	});
	db.query("INSERT INTO facts VALUES (?, ?, 'decant-daily', 1, ?, 0.4, ?)").run(
		"decant.claim.a7a7",
		'done work item W1 "done work item W1" → sha sha-W1',
		NOW - 60_000,
		stamp,
	);
	db.close();
}

test.describe("runDaily × pushDailyRoll (W1220 dual-write)", () => {
	function dailyOpts(
		dir: string,
		roll: boolean | object,
	): Parameters<typeof runDaily>[0] {
		return {
			dbPath: join(dir, "gov.db"),
			statePath: join(dir, "daily-state.json"),
			decantBin: writeDecantStub(dir),
			cwd: dir,
			coordBin: "coord-unused",
			windowMs: 24 * 3600_000,
			now: () => NOW,
			spawn: (_cmd: string[], _t: number) => ({ code: 0, out: "ok" }),
			roll,
		};
	}

	test("local facts stay primary; the roll rides after and stamps on ack", async () => {
		const dir = join(tmp, "e2e-ok");
		mkdirSync(dir);
		seedDailyDb(join(dir, "gov.db"));
		const rx = rollReceiver();
		const r = await runDaily(dailyOpts(dir, confFixture(dir, rx.url)));
		expect(r.ok).toBe(true); // the LOCAL result (unchanged contract)
		expect(r.roll?.pushed).toBe(true);
		expect(r.roll?.sent).toBe(1);
		expect(flatOf(rx)[0]?.evidenceId).toBe("work:W1"); // on the sink
		// the LOCAL cursor advanced (the local pass was clean — dual-write)
		expect(readState(join(dir, "daily-state.json")).lastRunMs).toBe(NOW);
		rx.stop();
	});

	test("sink outage: r.ok stays true (the local exit never moves)", async () => {
		const dir = join(tmp, "e2e-outage");
		mkdirSync(dir);
		seedDailyDb(join(dir, "gov.db"));
		const rx = rollReceiver();
		const conf = confFixture(dir, rx.url);
		rx.stop(); // the sink goes dark
		const r = await runDaily(dailyOpts(dir, conf));
		expect(r.ok).toBe(true); // fail-open: the local pass is still clean
		expect(r.roll?.ok).toBe(false); // the outage is logged, not fatal
		expect(r.roll?.errors.length).toBeGreaterThan(0);
		expect(r.roll?.sent).toBe(1);
		// and the local cursor advanced anyway — the local write is banked
		expect(readState(join(dir, "daily-state.json")).lastRunMs).toBe(NOW);
	});

	test("same-day rerun rolls zero new rows (the idempotent re-push)", async () => {
		const dir = join(tmp, "e2e-rerun");
		mkdirSync(dir);
		seedDailyDb(join(dir, "gov.db"));
		const rx = rollReceiver();
		const conf = confFixture(dir, rx.url);
		const r1 = await runDaily(dailyOpts(dir, conf));
		expect(r1.roll?.pushed).toBe(true);
		const hits = rx.got.length;
		const r2 = await runDaily(dailyOpts(dir, conf));
		expect(r2.ok).toBe(true);
		expect(r2.roll?.sent).toBe(0); // roll cursor: nothing new
		expect(r2.roll?.errors).toEqual([]);
		expect(rx.got.length).toBe(hits); // zero new rows ON the sink
		rx.stop();
	});
});
