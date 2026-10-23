// test/work-completion-reactivation.test.ts — W1173: a retained completion
// record is completed history. The observed incident: an item was retried to
// CLAIMED while its immutable work_completion_records row stood (0daf6a49);
// the next close collided on PK(project,item) and the raw SQL error surfaced
// as an opaque store failure. Regression: the real CLI fail/retry sequence
// refuses deterministically, and a re-close is refused before the INSERT.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	CompletionLookupUnavailableError,
	completionRecord,
	completionRecordStrict,
	completionTail,
	persistCompletion,
	prepareCompletion,
	reactivationRefusal,
} from "../hooks/lib/work-completion-record.ts";
import { retryFailedItem } from "../hooks/lib/work-retry.ts";
import {
	StoreSqlError,
	knownAbsentTable,
} from "../hooks/lib/store-sql-error.ts";

const recordOf = (item: string, sha: string) => ({
	project: "p",
	item,
	summary: "x".repeat(40),
	summary_hash: "h",
	commit_sha: sha,
	baseline_sha: null,
	completed_by: "lane-a",
	completed_at: Date.now(),
	capsule_json: "{}",
	evidence_json: "}",
});

// persistCompletion's ensureRecords mints the immutable table + triggers;
// the facts upsert inside persistCompletion needs the facts table.
const seededStore = (): GovernorStore => {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	persistCompletion(db, recordOf("W1", "0daf6a49000000000000"));
	return db;
};

// retryFailedItem's fixture shape (work-retry.test.ts) + the record table
const retryFixture = (state: string): GovernorStore => {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, updated_at INTEGER)",
	);
	db.run("CREATE TABLE claims(sid TEXT, scope TEXT, intent TEXT)");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	db.run(`INSERT INTO work_items VALUES ('p','W1','${state}','lane','s',100)`);
	persistCompletion(db, recordOf("W1", "0daf6a49000000000000"));
	return db;
};

describe("retained-completion fences (W1173)", () => {
	test("retry of a FAILED completed item refuses deterministically (not the PK collision)", () => {
		const r = retryFailedItem(retryFixture("FAILED"), "p", "W1");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("immutable completion record");
		expect(r.error).toContain("@0daf6a49");
		// W1173 typed refusal: callers key on the stable code, never SQL text
		expect(r.code).toBe("WORK_COMPLETION_RECORD_EXISTS");
	});

	test("retry of a DONE completed item refuses (guard precedes state logic)", () => {
		const r = retryFailedItem(retryFixture("DONE"), "p", "W1");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("immutable completion record");
	});

	test("re-close preflight refuses before any gate or git exec", () => {
		expect(() =>
			prepareCompletion(seededStore(), {
				project: "p",
				item: "W1",
				sid: "manual",
				cwd: process.cwd(),
				sha: null,
				summary: null,
			}),
		).toThrow("immutable completion record");
	});

	test("double persistCompletion refuses at the INSERT fence (smallest failing regression)", () => {
		expect(() =>
			persistCompletion(seededStore(), recordOf("W1", "0daf6a49000000000000")),
		).toThrow("immutable completion record");
	});

	test("legacy stores without the record table see no refusal (no false positive)", () => {
		const db = new Database(":memory:") as unknown as GovernorStore;
		expect(reactivationRefusal(db, "p", "W1")).toBeNull();
	});
});

describe("strict vs reader completion lookup (W1173.1.1)", () => {
	test("strict lookup reads the row and proves no-row as null", () => {
		const store = retryFixture("FAILED");
		expect(completionRecordStrict(store, "p", "W1")).not.toBeNull();
		expect(completionRecordStrict(store, "p", "W2")).toBeNull();
	});
	test("strict lookup throws the typed error; the loose reader still fails soft", () => {
		const store = busyLookup(retryFixture("FAILED"));
		expect(() => completionRecordStrict(store, "p", "W1")).toThrow(
			CompletionLookupUnavailableError,
		);
		// benign optional readers keep their fail-open behavior (W1173.1.1
		// preserves them separately): null, never a thrown refusal
		expect(completionRecord(store, "p", "W1")).toBeNull();
		expect(completionTail(store, "p", "W1")).toBeNull();
	});
	test("known-absent table: the strict lookup returns null on a legacy store", () => {
		const db = new Database(":memory:") as unknown as GovernorStore;
		expect(completionRecordStrict(db, "p", "W1")).toBeNull();
	});
	test("knownAbsentTable discriminates absence proofs from unknown failures", () => {
		const absent = Object.assign(
			new Error("no such table: work_completion_records"),
			{ code: "SQLITE_ERROR" },
		);
		const busy = Object.assign(new Error("database is locked"), {
			code: "SQLITE_BUSY",
		});
		const wireAbsent = new StoreSqlError(
			"governor store: no such table: work_completion_records",
			{
				err: "no such table: work_completion_records",
				code: "store_sql_fail",
				sqlite_code: "SQLITE_ERROR",
				executed: false,
			},
		);
		expect(knownAbsentTable(absent, "work_completion_records")).toBe(true);
		expect(knownAbsentTable(busy, "work_completion_records")).toBe(false);
		expect(knownAbsentTable(wireAbsent, "work_completion_records")).toBe(true);
	});
	test("prepare + persist gates fail closed with the typed error", () => {
		const store = busyLookup(retryFixture("FAILED"));
		expect(() =>
			prepareCompletion(store, {
				project: "p",
				item: "W1",
				sid: "manual",
				cwd: process.cwd(),
				sha: null,
				summary: null,
			}),
		).toThrow(CompletionLookupUnavailableError);
		expect(() =>
			persistCompletion(store, recordOf("W1", "0daf6a49000000000000")),
		).toThrow(CompletionLookupUnavailableError);
	});
});

// ── W1173.1.1 — fail closed when the immutable completion lookup is
// unavailable. FAIL61548 B2: the lookup's catch-all null read any lookup
// failure as "no record", so a real immutable row behind a transient failure
// (SQLITE_BUSY, HTTP store pressure) passed the reactivation gates — a
// FAILED→READY retry succeeded and stranded the graph against its own
// permanent record. The gates must discriminate: proven no-row or a
// known-absent record table proves absence; every other failure is
// unknown/unavailable and refuses while retaining claim state.
const busyLookup = (inner: GovernorStore): GovernorStore => {
	const busy = (): Error =>
		Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
	const recordsRead = /FROM work_completion_records/;
	return {
		local: true,
		close: () => inner.close(),
		query: (sql: string) => {
			if (recordsRead.test(sql)) throw busy();
			return inner.query(sql);
		},
		run: (sql: string, ...params: unknown[]) => inner.run(sql, ...params),
		transaction: (fn: () => unknown) => inner.transaction(fn),
	};
};
// the record-free twin of retryFixture: same tables, no completion record,
// so proven-absence paths contrast against the unavailable paths
const bareFixture = (): GovernorStore => {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, updated_at INTEGER)",
	);
	db.run("CREATE TABLE claims(sid TEXT, scope TEXT, intent TEXT)");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	db.run(`INSERT INTO work_items VALUES ('p','W1','FAILED','lane','s',100)`);
	return db;
};

const itemRow = (store: GovernorStore): unknown =>
	store
		.query("SELECT state, owner_sid, updated_at FROM work_items WHERE id='W1'")
		.get();
const claimCount = (store: GovernorStore): unknown =>
	store.query("SELECT COUNT(*) c FROM claims").get();

describe("shared retry fails closed on an unavailable lookup (W1173.1.1)", () => {
	test("transient lookup failure refuses a recorded FAILED item's retry", () => {
		const store = busyLookup(retryFixture("FAILED"));
		store.run("INSERT INTO claims VALUES ('lane','s','W1 anything')");
		const r = retryFailedItem(store, "p", "W1");
		expect(r.ok).toBe(false);
		expect(r.code).toBe("COMPLETION_LOOKUP_UNAVAILABLE");
		// the refused attempt advances nothing: state, owner, timestamp, claim
		expect(itemRow(store)).toEqual({
			state: "FAILED",
			owner_sid: "lane",
			updated_at: 100,
		});
		expect(claimCount(store)).toEqual({ c: 1 });
	});
	test("lookup failure refuses even with no record visible (absence unproven)", () => {
		const store = busyLookup(bareFixture());
		const r = retryFailedItem(store, "p", "W1");
		expect(r.ok).toBe(false);
		expect(r.code).toBe("COMPLETION_LOOKUP_UNAVAILABLE");
		// state retained: the item did NOT flip READY on an unproven lookup
		expect(itemRow(store)).toEqual({
			state: "FAILED",
			owner_sid: "lane",
			updated_at: 100,
		});
	});
	test("proven absence still allows the retry (no over-refusal)", () => {
		expect(retryFailedItem(bareFixture(), "p", "W1").ok).toBe(true);
	});
});

// ── W1173.1.1 — HTTP store pressure: the real client binding rides a
// transparent loopback proxy in front of the real store server; the record
// lookup is the pressured statement.
const HTTP_TIMEOUT = 20000;
// one isolated HOME per server: REG() resolves under HOME, so a shared
// directory would point every spawned server at the same governor.db
const httpHomes: string[] = [];
const serverProcs: ReturnType<typeof Bun.spawn>[] = [];
const proxyServers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
	for (const p of serverProcs) p.kill();
	for (const s of proxyServers) s.stop(true);
	for (const h of httpHomes) rmSync(h, { recursive: true, force: true });
});

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};
const startServer = async (port: number): Promise<string> => {
	const home = mkdtempSync(join(tmpdir(), "w1173-http-home-"));
	httpHomes.push(home);
	const p = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "..", "hooks", "bin", "store-server.ts"),
			"--port",
			String(port),
		],
		{
			env: { ...process.env, HOME: home, NO_COLOR: "1" },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	serverProcs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("store server did not come up");
};
// the proxy runs as its own child (a curl into a parent-process Bun.serve
// hangs on this macOS): it refuses exactly the record lookup with the chosen
// pressure flavor and forwards everything else (begin/rollback/other reads)
// to the real server
const pressureProxy = async (
	upstream: string,
	flavor: "http503" | "busy",
): Promise<string> => {
	const port = await freePort();
	const p = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "helpers", "pressure-proxy.ts"),
			String(port),
			upstream,
			flavor,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	serverProcs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("pressure proxy did not come up");
};
const makeClient = async (url: string): Promise<GovernorStore> => {
	const mod = (await import(
		join(import.meta.dir, "..", "hooks", "lib", "govdb-store.ts")
	)) as typeof import("../hooks/lib/govdb-store.ts");
	return new mod.HttpGovernorStore(url, null);
};
const httpSeed = (s: GovernorStore): void => {
	s.run(
		"INSERT INTO work_items (project,id,title,state,owner_sid,scope,created_at,updated_at) VALUES ('p','W1','t','FAILED','lane','s',100,100)",
	);
};
const wireSnapshot = (s: GovernorStore): unknown => ({
	it: s
		.query("SELECT state, owner_sid, updated_at FROM work_items WHERE id='W1'")
		.get(),
	rec:
		s.query("SELECT * FROM work_completion_records WHERE item='W1'").get() ??
		null,
});

describe("HTTP store pressure: an unavailable lookup fails closed (W1173.1.1)", () => {
	test(
		"known-absent record table over the real wire proves absence (no refusal)",
		async () => {
			const url = await startServer(await freePort());
			const s = await makeClient(url);
			httpSeed(s);
			// fresh governor.db has no record table: the server's typed
			// no-such-table refusal classifies as PROVEN absence — retry proceeds
			expect(reactivationRefusal(s, "p", "W1")).toBeNull();
			expect(retryFailedItem(s, "p", "W1").ok).toBe(true);
		},
		HTTP_TIMEOUT,
	);
	test(
		"lookup pressure refuses the retry and retains claim state (HTTP 503)",
		async () => {
			const url = await startServer(await freePort());
			const s = await makeClient(url);
			httpSeed(s);
			persistCompletion(s, recordOf("W1", "0daf6a49000000000000"));
			const before = wireSnapshot(s);
			const client = await makeClient(await pressureProxy(url, "http503"));
			const r = retryFailedItem(client, "p", "W1");
			expect(r.ok).toBe(false);
			expect(r.code).toBe("COMPLETION_LOOKUP_UNAVAILABLE");
			// begin + rollback rode the proxy; only the lookup was pressured —
			// the item row and the immutable record stand byte-identical
			expect(wireSnapshot(s)).toEqual(before);
		},
		HTTP_TIMEOUT,
	);
	test(
		"typed busy refusal on the lookup refuses the retry identically (SQLITE_BUSY envelope)",
		async () => {
			const url = await startServer(await freePort());
			const s = await makeClient(url);
			httpSeed(s);
			persistCompletion(s, recordOf("W1", "0daf6a49000000000000"));
			const before = wireSnapshot(s);
			const client = await makeClient(await pressureProxy(url, "busy"));
			const r = retryFailedItem(client, "p", "W1");
			expect(r.ok).toBe(false);
			expect(r.code).toBe("COMPLETION_LOOKUP_UNAVAILABLE");
			expect(wireSnapshot(s)).toEqual(before);
		},
		HTTP_TIMEOUT,
	);
});

const HOME = mkdtempSync(join(tmpdir(), "w1173-cli-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w1173-cli-repo-"));
Bun.spawnSync(["git", "init", "-q", REPO]);
afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const work = (args: string[]): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "bin", "work.ts"), ...args],
		{
			cwd: REPO,
			env: {
				...process.env,
				HOME: HOME,
				NO_COLOR: "1",
				GOVERNOR_STORE_URL: "local",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
};

const seed = (js: string): string => {
	const p = Bun.spawnSync(["bun", "-e", js], {
		cwd: REPO,
		env: {
			...process.env,
			HOME: HOME,
			NO_COLOR: "1",
			GOVERNOR_STORE_URL: "local",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`seed failed: ${p.stderr.toString()}`);
	return p.stdout.toString();
};

const storeLib = JSON.stringify(
	join(import.meta.dir, "..", "hooks", "lib", "govdb-store.ts"),
);
const recordLib = JSON.stringify(
	join(import.meta.dir, "..", "hooks", "lib", "work-completion-record.ts"),
);

describe("real CLI fail/retry over a retained record (W1173)", () => {
	test("fail and retry refuse with the deterministic diagnostic; evidence stands", () => {
		expect(work(["add", "w1173 reactivation item", "--by", "op"]).code).toBe(0);
		seed(`const { openStore } = await import(${storeLib});
const { persistCompletion } = await import(${recordLib});
const s = openStore();
const row = s.query("SELECT project FROM work_items WHERE id='W1'").get();
await persistCompletion(s, { project: row.project, item: "W1", summary: "x".repeat(40), summary_hash: "h", commit_sha: "0daf6a49000000000000", baseline_sha: null, completed_by: "lane-a", completed_at: Date.now(), capsule_json: "{}", evidence_json: "{}" });
console.log("seeded");`);
		// capture the exact pre-attempt state: the immutable receipt and the
		// item's row (the current claim) must survive the refusals byte-identical
		const before = seed(`const { openStore } = await import(${storeLib});
const s = openStore();
const rec = s.query("SELECT * FROM work_completion_records WHERE item='W1'").get();
const it = s.query("SELECT * FROM work_items WHERE id='W1'").get();
console.log(JSON.stringify({ rec, it }));`);
		const fail = work(["fail", "W1"]);
		expect(fail.code).not.toBe(0);
		expect(fail.err).toContain("immutable completion record");
		// the typed refusal code is the machine key (never a raw SQL string)
		expect(fail.err).toContain("WORK_COMPLETION_RECORD_EXISTS");
		const retry = work(["retry", "W1"]);
		expect(retry.code).not.toBe(0);
		expect(retry.err).toContain("immutable completion record");
		expect(retry.err).toContain("WORK_COMPLETION_RECORD_EXISTS");
		const after = seed(`const { openStore } = await import(${storeLib});
const s = openStore();
const rec = s.query("SELECT * FROM work_completion_records WHERE item='W1'").get();
const it = s.query("SELECT * FROM work_items WHERE id='W1'").get();
console.log(JSON.stringify({ rec, it }));`);
		// claim rollback: the refused attempts advance nothing — the item row
		// and the immutable receipt are byte-identical across both refusals
		expect(JSON.parse(after)).toEqual(JSON.parse(before));
		// the immutable evidence itself must stand untouched after both refusals
		expect(
			seed(`const { openStore } = await import(${storeLib});
const s = openStore();
const row = s.query("SELECT commit_sha FROM work_completion_records WHERE item='W1'").get();
console.log(String(row.commit_sha));`),
		).toContain("0daf6a49");
	});
});
