// test/knowledge-sync.test.ts — W944: the spoke→hub knowledge sync.
// Covers: the 0600 policy-config validator, the structural content deny
// (decant title/project_path never appear in any projected payload), the
// facts local-verification chain (vocabulary + redactSecrets + version
// delta), and the hub-side landing (candidate-state facts, idempotent
// metrics upserts, strict row validation). The route-shape tests avoid the
// real board db — landing is tested through the db-injected core.
import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { tmpDir } from "./helpers/fixture-kit.ts";
import { join } from "node:path";
import {
	DEFAULT_POLICY,
	readSyncConfig,
	opaqueSessionId,
	projectSessionMetrics,
	projectStatsMetrics,
} from "../hooks/lib/knowledge/knowledge-sync-policy.ts";
import {
	SYNCABLE_FACT,
	collectFacts,
	readSyncState,
	syncOnce,
	type SyncOnceResult,
	type SyncState,
} from "../hooks/lib/knowledge/knowledge-sync.ts";
import {
	landKnowledgeIngest,
	handleKnowledgeIngest,
} from "../hooks/board/knowledge-ingest.ts";

// ─── config validator ───────────────────────────────────────────────────────

test("readSyncConfig: missing file = clean disabled (null)", () => {
	expect(readSyncConfig(join(tmpdir(), `w944-none-${Date.now()}`))).toBeNull();
});

test("readSyncConfig: enforces 0600 exactly", () => {
	const dir = tmpDir("w944-cfg-");
	const path = join(dir, "knowledge-sync.json");
	writeFileSync(
		path,
		JSON.stringify({
			localHub: "devbox",
			targets: [{ url: "https://hub.local", writeTokenFile: "/tmp/t" }],
		}),
		{ mode: 0o644 },
	);
	expect(() => readSyncConfig(path)).toThrow();
	rmSync(dir, { recursive: true, force: true });
});

test("readSyncConfig: unknown policy key refused (policy only toggles known classes)", () => {
	const dir = tmpDir("w944-cfg-");
	const path = join(dir, "knowledge-sync.json");
	writeFileSync(
		path,
		JSON.stringify({
			localHub: "devbox",
			targets: [{ url: "https://hub.local", writeTokenFile: "/tmp/t" }],
			policy: { transcripts: true },
		}),
		{ mode: 0o600 },
	);
	expect(() => readSyncConfig(path)).toThrow();
	rmSync(dir, { recursive: true, force: true });
});

test("readSyncConfig: valid config parses with default policy + url rules", () => {
	const dir = tmpDir("w944-cfg-");
	const path = join(dir, "knowledge-sync.json");
	writeFileSync(
		path,
		JSON.stringify({
			localHub: "devbox",
			targets: [
				{ url: "https://hub.local", hubId: "nas", writeTokenFile: "/tmp/t" },
			],
		}),
		{ mode: 0o600 },
	);
	const config = readSyncConfig(path);
	expect(config).not.toBeNull();
	expect(config?.policy).toEqual(DEFAULT_POLICY);
	expect(config?.targets[0]?.url).toBe("https://hub.local");
	expect(config?.decantBin).toBe("decant");
	rmSync(dir, { recursive: true, force: true });
});

// ─── the structural content deny ────────────────────────────────────────────

test("projectSessionMetrics: content fields never appear in the projected row", () => {
	const row = {
		id: 255,
		source_session_id: "6d9dbbd0-4f47-4e63-bbc7-73a4cb97d252",
		title: "SECRET-CONTENT transcript innerText",
		project_path: "/Users/someone/secret-project", // scrub:allow (trap fixture)
		tool: "claude_code",
		model: "glm-5.3-flash",
		started_at: "2026-10-19T18:58:04.646Z",
		ended_at: "2026-10-19T19:01:17.650Z",
		message_count: 83,
		total_input_tokens: 33126,
		total_output_tokens: 626,
		estimated_cost_usd: 0.023,
	};
	const projected = projectSessionMetrics(row);
	const serialized = JSON.stringify(projected);
	expect(serialized).not.toContain("SECRET-CONTENT");
	expect(serialized).not.toContain("secret-project");
	expect(projected.sessionId).toBe(
		opaqueSessionId("6d9dbbd0-4f47-4e63-bbc7-73a4cb97d252"),
	);
	expect(projected.durationMs).toBeGreaterThan(0);
});

test("projectStatsMetrics: projects stats rows, nulls on garbage", () => {
	const good = projectStatsMetrics({
		key: "2026-10-19",
		sessions: 17,
		input_tokens: 822146,
		output_tokens: 125757,
		estimated_cost_usd: 0.385,
	});
	expect(good).not.toBeNull();
	expect(good?.tokens).toBe(947903);
	expect(good?.costUsd).toBe(0.385);
	const bad = projectStatsMetrics({ key: "x", sessions: "many" });
	expect(bad).toBeNull();
});

// ─── facts: local verification before crossing ──────────────────────────────

test("SYNCABLE_FACT matches the lesson/finding vocabulary only", () => {
	expect(SYNCABLE_FACT.test("lesson.foo")).toBe(true);
	expect(SYNCABLE_FACT.test("finding.bar")).toBe(true);
	expect(SYNCABLE_FACT.test("work.state")).toBe(false);
	expect(SYNCABLE_FACT.test("lessonx.1")).toBe(false);
});

test("collectFacts: vocabulary + secret + version gates on a fixture db", () => {
	const dir = tmpDir("w944-facts-");
	const dbPath = join(dir, "governor.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL)",
	);
	db.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lesson.tok', 'pin env knobs in fixture env', 'lane', 1, 1)",
	);
	db.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('finding.scrub', 'scrub gate flags ADDED lines only', 'lane', 1, 1)",
	);
	db.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lesson.secret', 'token ghp_REDACTEDSECRET1234567890', 'lane', 1, 1)", // scrub:allow (trap fixture)
	);
	db.close();
	const state: SyncState = { facts: { "lesson.tok": 1 }, metricsAt: 0 };
	const out = collectFacts(state, { dbPath });
	expect(out.send.map((f) => f.key)).toEqual(["finding.scrub"]);
});

test("readSyncConfig: non-loopback http target refused", () => {
	const dir = tmpDir("w944-cfg-");
	const path = join(dir, "knowledge-sync.json");
	writeFileSync(
		path,
		JSON.stringify({
			localHub: "devbox",
			targets: [{ url: "http://hub.lan", writeTokenFile: "/tmp/t" }],
		}),
		{ mode: 0o600 },
	);
	expect(() => readSyncConfig(path)).toThrow();
	rmSync(dir, { recursive: true, force: true });
});

// ─── hub landing ────────────────────────────────────────────────────────────

function fixtureKb(): Database {
	const kdb = new Database(":memory:");
	kdb.run(
		"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, topic TEXT, fact TEXT, confidence REAL, origin_kind TEXT, origin_system TEXT, origin_sid TEXT, contributors TEXT, source TEXT, state TEXT, confidence_stamp TEXT, provenance TEXT)",
	);
	return kdb;
}

const factRow = (key: string, value: string) => ({
	key,
	value,
	source: "lane",
	version: 1,
	ts: 1,
});

test("landKnowledgeIngest: facts land as candidate rows (unverified marker)", () => {
	const kdb = fixtureKb();
	const result = landKnowledgeIngest(kdb, {
		originHub: "devbox",
		metrics: {},
		facts: [factRow("lesson.tok", "pin env knobs in fixture env")],
	});
	expect(result.ok).toBe(true);
	expect(result.counts?.facts.landed).toBe(1);
	const row = kdb
		.query(
			"SELECT state, source, origin_kind FROM knowledge WHERE topic = 'lesson.tok'",
		)
		.get() as { state: string; source: string; origin_kind: string };
	expect(row.state).toBe("candidate");
	expect(row.source).toBe("knowledge-sync");
});

test("landKnowledgeIngest: dupe topics skip (local rows never displaced)", () => {
	const kdb = fixtureKb();
	const payload = {
		originHub: "devbox",
		metrics: {},
		facts: [factRow("lesson.tok", "v1")],
	};
	expect(landKnowledgeIngest(kdb, payload).counts?.facts.landed).toBe(1);
	const dupe = landKnowledgeIngest(kdb, payload);
	expect(dupe.counts?.facts.dupes).toBe(1);
	const n = kdb.query("SELECT COUNT(*) AS n FROM knowledge").get() as {
		n: number;
	};
	expect(n.n).toBe(1);
});

test("landKnowledgeIngest: metrics upsert idempotent by (hub, dim, key)", () => {
	const kdb = fixtureKb();
	const payload = {
		originHub: "devbox",
		metrics: {
			days: [
				{ key: "2026-10-19", sessions: 17, tokens: 947903, costUsd: 0.385 },
			],
		},
		facts: [],
	};
	expect(landKnowledgeIngest(kdb, payload).counts?.metrics).toBe(1);
	landKnowledgeIngest(kdb, payload);
	const n = kdb.query("SELECT COUNT(*) AS n FROM sync_metrics").get() as {
		n: number;
	};
	expect(n.n).toBe(1);
});

test("landKnowledgeIngest: metrics row with unknown field refused", () => {
	const kdb = fixtureKb();
	const bad = landKnowledgeIngest(kdb, {
		originHub: "devbox",
		metrics: {
			days: [{ key: "2026-10-19", sessions: 17, tokens: 1, extra: "junk" }],
		},
		facts: [],
	});
	expect(bad.ok).toBe(false);
});

test("handleKnowledgeIngest: route shape guards", async () => {
	const url = new URL("http://board.local/api/knowledge-ingest");
	const miss = await handleKnowledgeIngest(
		new Request("http://board.local/api/other"),
		new URL("http://board.local/api/other"),
	);
	expect(miss).toBeNull();
	const notAllowed = await handleKnowledgeIngest(
		new Request(url, { method: "DELETE" }),
		url,
	);
	expect(notAllowed?.status).toBe(405);
	const wrongCt = await handleKnowledgeIngest(
		new Request(url, {
			method: "POST",
			body: "{}",
			headers: { "content-type": "text/plain" },
		}),
		url,
	);
	expect(wrongCt?.status).toBe(415);
});

// ─── e2e: deterministic round-trip — a FAKE decant bin (decantBin accepts
// an absolute path) drives spawn → parse → project → POST → receiver. The
// fake ls row CARRIES content fields; the wire payload must still be
// content-free — the deny is structural. ────────────────────────────────────

test("e2e: syncOnce posts decant metrics + facts to a local receiver", async () => {
	const dir = tmpDir("w944-e2e-");
	// the fake decant: one stats row per dim; the ls row carries content
	const binPath = join(dir, "decant-fake");
	// the fake decant: one stats row per dim; the ls row carries content
	writeFileSync(
		binPath,
		[
			"#!/usr/bin/env bun",
			"const a = process.argv;",
			"const s = {",
			"  id: 1,",
			'  source_session_id: "6d9dbbd0-4f47-4e63-bbc7-73a4cb97d252",',
			'  title: "SECRET-CONTENT trap: the wire must stay content-free",',
			'  project_path: "/Users/someone/secret-project",', // scrub:allow (trap fixture)
			'  tool: "claude_code",',
			'  model: "glm-5.3-flash",',
			'  started_at: "2026-10-19T10:00:00Z",',
			'  ended_at: "2026-10-19T11:00:00Z",',
			"  message_count: 8,",
			"  total_input_tokens: 100,",
			"  total_output_tokens: 20,",
			"  estimated_cost_usd: 0.02,",
			"};",
			'if (a[2] === "stats")',
			'\tconsole.log(JSON.stringify([{ key: "d1", sessions: 2, input_tokens: 100, output_tokens: 20, estimated_cost_usd: 0.02 }]));',
			'else if (a[2] === "ls") console.log(JSON.stringify([s]));',
		].join("\n"),
		{ mode: 0o755 },
	);
	let captured: string | null = null;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			captured = await req.text();
			// W1213.2: the receiver acks like the real hub — explicit ok:true
			// plus counters matched to the batch it just landed.
			const p = JSON.parse(captured) as {
				facts: unknown[];
				metrics: Record<string, unknown[]>;
			};
			const rows = Object.values(p.metrics).reduce(
				(n, rows) => n + rows.length,
				0,
			);
			return Response.json(JSON.parse(ingestAck(p.facts.length, rows)));
		},
	});
	const tokenPath = join(dir, "hub.token");
	writeFileSync(tokenPath, "e2e-token", { mode: 0o600 });
	const cfgPath = join(dir, "knowledge-sync.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			localHub: "e2e-devbox",
			targets: [
				{
					url: `http://127.0.0.1:${server.port}`,
					writeTokenFile: tokenPath,
				},
			],
			policy: { metrics: true, metricsSessions: true, facts: true },
			decantBin: binPath,
		}),
		{ mode: 0o600 },
	);
	const dbPath = join(dir, "governor.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL)",
	);
	db.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lesson.e2e', 'wire-only metrics, candidate facts', 'lane', 1, 1)",
	);
	db.close();
	const statePath = join(dir, "state.json");
	const result = await syncOnce({ configPath: cfgPath, statePath, dbPath });
	// the pass accepted end-to-end: outcome ok + the fact cursor stamped
	expect(result.outcomes[0]?.ok).toBe(true);
	const state = JSON.parse(readFileSync(statePath, "utf8")) as {
		facts: Record<string, number>;
	};
	expect(state.facts["lesson.e2e"]).toBe(1);
	// the wire payload: content-free + projected rows arrived
	expect(captured).not.toBeNull();
	const payload = JSON.parse(captured as string) as {
		metrics: {
			days: { tokens: number }[];
			sessions: { sessionId: string; durationMs: number | null }[];
		};
	};
	expect(payload.metrics.days[0]?.tokens).toBe(120);
	expect(payload.metrics.sessions[0]?.sessionId).toBe(
		opaqueSessionId("6d9dbbd0-4f47-4e63-bbc7-73a4cb97d252"),
	);
	expect(payload.metrics.sessions[0]?.durationMs).toBe(3_600_000);
	const wire = captured as string;
	expect(wire).not.toContain("SECRET-CONTENT");
	expect(wire).not.toContain("secret-project");
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
}, 30_000);

test("landKnowledgeIngest: out-of-vocabulary keys rejected, bad payloads 400-shaped", () => {
	const kdb = fixtureKb();
	expect(landKnowledgeIngest(kdb, null).ok).toBe(false);
	expect(landKnowledgeIngest(kdb, { originHub: "" }).ok).toBe(false);
	const bad = landKnowledgeIngest(kdb, {
		originHub: "devbox",
		metrics: {},
		facts: [factRow("work.state", "x")],
	});
	expect(bad.ok).toBe(true);
	expect(bad.counts?.facts.rejected).toBe(1);
	const badHub = landKnowledgeIngest(kdb, {
		originHub: "all",
		metrics: {},
		facts: [],
	});
	expect(badHub.ok).toBe(false);
});

// ─── W1213.2: the cursor advances only on an explicit, validated,
// batch-matched positive ack (real-HTTP receiver cases below). ──────────────

/** The ack body the real hub returns for a landed batch, stringified. */
const ingestAck = (
	facts: number,
	metrics: number,
	over: Partial<{
		ok: unknown;
		error: string;
		landed: number;
		dupes: number;
		rejected: number;
	}> = {},
): string =>
	JSON.stringify(
		over.ok !== undefined || over.error !== undefined
			? { ok: over.ok ?? false, error: over.error ?? null }
			: {
					ok: true,
					counts: {
						facts: {
							landed: over.landed ?? facts,
							dupes: over.dupes ?? 0,
							rejected: over.rejected ?? 0,
						},
						metrics,
					},
				},
	);

// ─── W1213.2 real-HTTP receiver cases: only a validated, batch-matched
// positive ack advances the cursor — every other 200 keeps it for retry. ────

/** The one-fact facts db the sync pass collects from. */
const ackFixtureDb = (dir: string): string => {
	const dbPath = join(dir, "governor.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL, ts INTEGER NOT NULL)",
	);
	db.run(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lesson.e2e', 'cursor only moves on a validated batch-matched ack', 'lane', 1, 1)",
	);
	db.close();
	return dbPath;
};

/** The REAL loopback receiver: parses each landed batch, records the fact
 *  keys+versions it received, and answers with the ack body the test set. */
const ackReceiver = (): {
	received: { key: string; version: number }[][];
	setAck: (body: (sentFacts: number, sentMetrics: number) => string) => void;
	stop: () => void;
	url: string;
} => {
	const received: { key: string; version: number }[][] = [];
	let ackBody: (sentFacts: number, sentMetrics: number) => string = (f, m) =>
		ingestAck(f, m);
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const p = (await req.json()) as {
				facts: { key: string; version: number }[];
			};
			received.push(p.facts.map((f) => ({ key: f.key, version: f.version })));
			return new Response(ackBody(p.facts.length, 0), {
				headers: { "content-type": "application/json" },
			});
		},
	});
	return {
		received,
		setAck: (body) => {
			ackBody = body;
		},
		stop: () => server.stop(true),
		url: `http://127.0.0.1:${server.port}`,
	};
};

/** The 0600 sync config: one loopback target, facts-only policy (no decant
 *  spawn — the bare "decant" name passes validation and is never run). */
const ackFixtureConfig = (url: string, dir: string): { cfgPath: string } => {
	const tokenPath = join(dir, "hub.token");
	writeFileSync(tokenPath, "e2e-token", { mode: 0o600 });
	const cfgPath = join(dir, "knowledge-sync.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			localHub: "w12132-devbox",
			targets: [{ url, writeTokenFile: tokenPath }],
			policy: { facts: true, metrics: false, metricsSessions: false },
			decantBin: "decant",
		}),
		{ mode: 0o600 },
	);
	return { cfgPath };
};

/** One sync fixture riding the real receiver: fixture home + facts db +
 *  0600 config, with a closer that stops the server and removes the dir. */
const ackSyncHarness = (): {
	received: { key: string; version: number }[][];
	setAck: (body: (sentFacts: number, sentMetrics: number) => string) => void;
	cfgPath: string;
	statePath: string;
	dbPath: string;
	close: () => void;
} => {
	const dir = tmpDir("w12132-ack-");
	const rx = ackReceiver();
	const { cfgPath } = ackFixtureConfig(rx.url, dir);
	const dbPath = ackFixtureDb(dir);
	return {
		received: rx.received,
		setAck: rx.setAck,
		cfgPath,
		statePath: join(dir, "state.json"),
		dbPath,
		close: () => {
			rx.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
};

const ackPass = (
	h: ReturnType<typeof ackSyncHarness>,
): Promise<SyncOnceResult> =>
	syncOnce({ configPath: h.cfgPath, statePath: h.statePath, dbPath: h.dbPath });

test("syncOnce: 200 {ok:false} rejection retains the cursor; retry re-sends the same batch then stamps", async () => {
	const h = ackSyncHarness();
	h.setAck((f, m) =>
		ingestAck(f, m, { ok: false, error: "confidence 99 invalid" }),
	);
	const r1 = await ackPass(h);
	expect(r1.outcomes[0]?.ok).toBe(false);
	expect(r1.outcomes[0]?.error).toContain("confidence 99 invalid");
	// a rejection is a non-ack: the cursor stays where it was
	expect(readSyncState(h.statePath).facts["lesson.e2e"]).toBeUndefined();
	// flip to a matched ack: the SAME batch re-sends, then the cursor stamps
	h.setAck((f, m) => ingestAck(f, m));
	const r2 = await ackPass(h);
	expect(r2.outcomes[0]?.ok).toBe(true);
	expect(h.received.length).toBe(2);
	expect(h.received[0]).toEqual(h.received[1]);
	expect(readSyncState(h.statePath).facts["lesson.e2e"]).toBe(1);
	h.close();
}, 30_000);

test("syncOnce: malformed 200 body retains the cursor", async () => {
	const h = ackSyncHarness();
	h.setAck(() => "not-json{{");
	const r = await ackPass(h);
	expect(r.outcomes[0]?.ok).toBe(false);
	expect(r.outcomes[0]?.error).toBe("ingest ack unparseable");
	expect(readSyncState(h.statePath).facts["lesson.e2e"]).toBeUndefined();
	h.close();
}, 30_000);

test("syncOnce: counters not matching the batch retain the cursor", async () => {
	const h = ackSyncHarness();
	// under-count: the ack accounts for 0 of the 1 sent fact
	h.setAck((f, m) => ingestAck(f, m, { landed: 0, dupes: 0, rejected: 0 }));
	const r1 = await ackPass(h);
	expect(r1.outcomes[0]?.ok).toBe(false);
	expect(r1.outcomes[0]?.error).toBe(
		"ingest ack accounts for 0 of 1 sent facts",
	);
	// exact accounting but one row rejected is still a non-ack
	h.setAck((f, m) => ingestAck(f, m, { landed: 0, dupes: 0, rejected: 1 }));
	const r2 = await ackPass(h);
	expect(r2.outcomes[0]?.ok).toBe(false);
	expect(r2.outcomes[0]?.error).toBe("ingest ack rejects 1 fact(s)");
	expect(readSyncState(h.statePath).facts["lesson.e2e"]).toBeUndefined();
	h.close();
}, 30_000);

test("syncOnce: bare 200 {ok:true} without counters retains the cursor", async () => {
	const h = ackSyncHarness();
	h.setAck(() => ingestAck(1, 0, { ok: true }));
	const r = await ackPass(h);
	expect(r.outcomes[0]?.ok).toBe(false);
	expect(r.outcomes[0]?.error).toBe("ingest ack carries no counters");
	expect(readSyncState(h.statePath).facts["lesson.e2e"]).toBeUndefined();
	h.close();
}, 30_000);
