// consult-federation.test.ts — W934.2.1.2: the durable consult envelope
// (trace id + idempotency key), routing-ladder citations for KB/FACT answers,
// stale-fact feedback (failed feedback demotes the cited fact; resolved is
// audit-only), and the outbound hub leg: bounded POST, honest states,
// singleflight join, negative cache. Isolated temp HOME + repo, spawns the
// real CLI (consult-kb recipe) against an in-process mock hub.

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ConsultEnvelope,
	ensureConsultFederation,
	mintTraceId,
} from "../hooks/lib/consult-federation.ts";
import {
	attemptHubLeg,
	hubCooldownActive,
	joinPendingHubConsult,
} from "../hooks/lib/consult-federation-hub.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-fed-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-fed-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
mkdirSync(join(REPO, "docs"), { recursive: true });
const env = { ...process.env, HOME, SUSPENDERS_KEV_URL: "http://127.0.0.1:1" };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const KDB = join(HOME, ".cache", "claude-governor", "knowledge.db");
const POLICY = join(HOME, "consult-federation.json");

// projectIdentity(), mirrored: git walks UP through a scaffolded .git, so the
// identity is the PARENT repo's .git — seeds must match it exactly
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
const TS = Date.now();
const EXPT = "expert-fed-11111111";
const ASKER = "asker-fed-22222222";

function run(args: string[], overrides: Record<string, string> = {}) {
	const p = Bun.spawnSync(["bun", coord, ...args], {
		cwd: REPO,
		env: { ...env, ...overrides },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

// bootstrap: first CLI open runs the migrations so seeds have a schema
run(["kb", "stats"]);

function seedSession(sid: string): void {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
	).run(sid, PROJ, TS, TS);
	db.close();
}

// seed a hash-verifiable knowledge row (trustOf hashes join(cwd, source_ref))
function seedFact(topic: string, fact: string, file: string): number {
	const content = `# ${topic}\n\n${fact}\n`;
	writeFileSync(join(REPO, file), content);
	const hash = createHash("sha256").update(content).digest("hex");
	const d = new Database(KDB);
	const r = d
		.query(
			"INSERT INTO knowledge (ts, topic, fact, confidence, state, source_ref, source_hash, created_at, updated_at) VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?)",
		)
		.run(Date.now(), topic, fact, file, hash, Date.now(), Date.now());
	d.close();
	return Number(r.lastInsertRowid);
}

interface FedRow {
	consult_id: number;
	trace_id: string;
	idempotency_key: string;
	route: string;
	hub: string | null;
	state: string;
}

function fedRow(consultId: number): FedRow | undefined {
	const d = new Database(DB, { readonly: true });
	const r = d
		.query(
			"SELECT consult_id, trace_id, idempotency_key, route, hub, state FROM consult_federation WHERE consult_id = ?",
		)
		.get(consultId) as FedRow | undefined;
	d.close();
	return r;
}

function citeCount(consultId: number, kind: string): number {
	const d = new Database(DB, { readonly: true });
	const r = d
		.query(
			"SELECT COUNT(*) AS n FROM consult_citations WHERE consult_id = ? AND kind = ?",
		)
		.get(consultId, kind) as { n: number };
	d.close();
	return r.n;
}

function rows(sql: string, ...params: unknown[]) {
	const d = new Database(DB, { readonly: true });
	const r = d.query(sql).all(...params);
	d.close();
	return r as Record<string, unknown>[];
}

// ─── mock hub ───
// resolveHub's per-label env override skips liveness probing, so pointing
// SUSPENDERS_HUB_TESTHUB_URL at this server is enough; the mode toggles the
// verdict per test (200 answer / 202 pending / 500 degrade).
let mode: "ok" | "pending" | "err" = "ok";
let hits = 0;
const hub = Bun.serve({
	port: 0,
	fetch(req) {
		hits++;
		const u = new URL(req.url);
		if (u.pathname !== "/v1/consult")
			return new Response("nope", { status: 404 });
		if (mode === "pending") return new Response(null, { status: 202 });
		if (mode === "err") return new Response("boom", { status: 500 });
		return Response.json({
			answer: "flush via coord zebra-flush",
			citations: [
				{ ref_id: 77, source_ref: "docs/zebra.md", source_hash: "abc123" },
			],
		});
	},
});
const HUB_URL = `http://127.0.0.1:${hub.port}`;
// in-process wire tests resolve policy.hub = "mock" through this override
process.env.SUSPENDERS_HUB_MOCK_URL = HUB_URL;
const HUB_ENV = {
	SUSPENDERS_CONSULT_FEDERATION_FILE: POLICY,
	SUSPENDERS_HUB_TESTHUB_URL: HUB_URL,
};
writeFileSync(
	POLICY,
	JSON.stringify({
		enabled: true,
		hub: "testhub",
		deadlineMs: 2000,
		cooldownMs: 300000,
	}),
);

const Q_KB = "How do we fix the retry contract for stale leases?";
const Q_FACT1 = "how do I flush the zebra queue before a snapshot restore";
const Q_FACT2 =
	"does the quokka ledger need the checksum column before migration";
const Q_HUB = "what governs the quokka rollout cadence";
const Q_SCOPED = "how should the veil cache invalidate across pods";

afterAll(() => {
	hub.stop(true);
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// in-process fixture db for the hub-wire tests (spawned-process loopback is
// blocked on this macOS — child CLIs can never reach the mock)
function fixtureDb(name: string) {
	const db = new Database(join(HOME, name));
	db.run(
		"CREATE TABLE consults (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, asker_sid TEXT, expert_sid TEXT, question TEXT, scope TEXT, state TEXT, answer TEXT, answered_at INTEGER, created_at INTEGER)",
	);
	db.run(
		"CREATE TABLE events (ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	ensureConsultFederation(db);
	return db;
}

const TEST_POLICY = {
	enabled: true as const,
	hub: "mock",
	deadlineMs: 2000,
	cooldownMs: 300000,
};

const ENV = (key: string): ConsultEnvelope => ({
	consultId: "",
	traceId: mintTraceId(),
	idempotencyKey: key,
	origin: ASKER,
	project: PROJ,
	scope: null,
	maxHops: 1,
	visitedHubs: [],
});

function citesOf(db: Database, cid: number | null) {
	if (cid === null) return [];
	return db
		.query("SELECT kind, ref_id FROM consult_citations WHERE consult_id = ?")
		.all(cid) as { kind: string; ref_id: number }[];
}

test("kb answer stamps envelope + kb citation; key stable across re-ask", () => {
	seedSession(EXPT);
	const ask = run([
		"consult",
		EXPT,
		Q_KB,
		"--scope",
		"hooks/leases",
		"--version",
		"test-version",
		"--as",
		ASKER,
	]);
	expect(ask.code).toBe(0);
	expect(ask.out).toContain("CONSULT C1");
	const e1 = fedRow(1);
	expect(e1?.state).toBe("OPEN");
	expect(e1?.trace_id).toMatch(/^[0-9a-f]{32}$/);
	const reply = run([
		"consult-reply",
		"C1",
		"Release the stale lease via coord lease-release, then re-take the file.",
		"--version",
		"test-version",
		"--as",
		EXPT,
	]);
	expect(reply.code).toBe(0);
	run([
		"consult-reply",
		"C1",
		"--feedback",
		"resolved",
		"--evidence",
		"Lease released and subsequent take succeeded",
		"--version",
		"test-version",
		"--as",
		ASKER,
	]);
	const reask = run([
		"consult",
		EXPT,
		Q_KB,
		"--scope",
		"hooks/leases",
		"--version",
		"test-version",
		"--as",
		ASKER,
	]);
	expect(reask.code).toBe(0);
	expect(reask.out).toContain("knowledge base");
	const e2 = fedRow(2);
	expect(e2?.state).toBe("KB");
	expect(e2?.idempotency_key).toBe(e1?.idempotency_key);
	expect(e2?.route).toContain('"kb"');
	expect(citeCount(2, "kb")).toBe(1);
});

test("fact answer cites the knowledge row id", () => {
	const k1 = seedFact(
		"zebra queue snapshot",
		"always flush the zebra queue before snapshot restore",
		"docs/zebra.md",
	);
	const ask = run(["consult", "--best", Q_FACT1, "--as", ASKER]);
	expect(ask.code).toBe(0);
	expect(ask.out).toContain("answered from a verified fleet fact");
	const e = fedRow(3);
	expect(e?.state).toBe("FACT");
	expect(e?.route).toContain('"fact"');
	expect(citeCount(3, "fact")).toBe(1);
	const cite = rows(
		"SELECT ref_id FROM consult_citations x JOIN consults c ON c.id = x.consult_id WHERE c.question = ? AND x.kind = 'fact'",
		Q_FACT1,
	)[0] as { ref_id: number };
	expect(cite?.ref_id).toBe(k1);
});

test("failed feedback demotes the cited fact — re-ask routes past it", () => {
	const reply = run([
		"consult-reply",
		"C3",
		"--feedback",
		"failed",
		"--evidence",
		"zebra-flush ran, queue still stuck",
		"--as",
		ASKER,
	]);
	if (reply.code !== 0) console.error("REPLY", JSON.stringify(reply));
	expect(reply.code).toBe(0);
	expect(reply.out).toContain("demoted");
	const stale = rows(
		"SELECT COUNT(*) AS n FROM events WHERE kind = 'knowledge.stale' AND payload LIKE '%C3%'",
	)[0] as { n: number };
	expect(stale?.n).toBe(1);
	const reask = run(["consult", "--best", Q_FACT1, "--as", ASKER]);
	expect(reask.code).toBe(2);
	expect(reask.out).not.toContain("ANSWERED");
});

test("resolved feedback is audit-only — no demotion", () => {
	const k2 = seedFact(
		"quokka ledger",
		"the quokka ledger needs the checksum column before any migration",
		"docs/quokka.md",
	);
	const ask = run(["consult", "--best", Q_FACT2, "--as", ASKER]);
	expect(ask.code).toBe(0);
	expect(ask.out).toContain("answered from a verified fleet fact");
	const cite = rows(
		"SELECT ref_id FROM consult_citations x JOIN consults c ON c.id = x.consult_id WHERE c.question = ? AND x.kind = 'fact'",
		Q_FACT2,
	)[0] as { ref_id: number };
	expect(cite?.ref_id).toBe(k2);
	const reply = run([
		"consult-reply",
		"C4",
		"--feedback",
		"resolved",
		"--evidence",
		"migration ran clean",
		"--as",
		ASKER,
	]);
	expect(reply.code).toBe(0);
	expect(reply.out).toContain("resolved");
	const stale = rows(
		"SELECT COUNT(*) AS n FROM events WHERE kind = 'knowledge.stale' AND payload LIKE '%C4%'",
	)[0] as { n: number };
	expect(stale?.n).toBe(0);
});

test("hub wire: ANSWERED writes answer + hub citations + trace event", async () => {
	mode = "ok";
	const db = fixtureDb("fix5.db");
	const envelope = ENV("k-fix5");
	const v = await attemptHubLeg(db, envelope, Q_HUB, TEST_POLICY, {});
	expect(v.handled).toBe(true);
	expect(v.answer).toBe("flush via coord zebra-flush");
	const c = db
		.query("SELECT state, answer FROM consults WHERE id = ?")
		.get(v.cid) as { state: string; answer: string };
	expect(c?.state).toBe("HUB");
	expect(c?.answer).toBe("flush via coord zebra-flush");
	expect(citesOf(db, v.cid)).toEqual([{ kind: "hub", ref_id: 77 }]);
	const ev = db
		.query("SELECT payload FROM events WHERE kind = 'consult.answer'")
		.get() as { payload: string };
	expect(JSON.parse(ev?.payload ?? "{}").hub.trace_id).toBe(envelope.traceId);
});

test("hub wire: degrade sets cooldown; PENDING joins; rows stamped HUB_MISS", async () => {
	mode = "err";
	const db = fixtureDb("fix6.db");
	const envelope = ENV("k-fix6");
	const v = await attemptHubLeg(db, envelope, Q_HUB, TEST_POLICY, {});
	expect(v.handled).toBe(false);
	const c = db.query("SELECT state FROM consults WHERE id = ?").get(v.cid) as {
		state: string;
	};
	expect(c?.state).toBe("HUB_MISS");
	const cache = db.query("SELECT until FROM consult_hub_cache").get() as {
		until: number;
	};
	expect(cache?.until).toBeGreaterThan(Date.now());
	expect(hubCooldownActive(db, "k-fix6")).toBe(true);
	db.query(
		"UPDATE consult_federation SET state = 'PENDING' WHERE consult_id = ?",
	).run(v.cid);
	expect(joinPendingHubConsult(db, "k-fix6", 600_000)).toBe(v.cid);
});

test("scoped consult never contacts the hub", () => {
	mode = "ok";
	const before = hits;
	const ask = run(
		["consult", "--best", Q_SCOPED, "--scope", "hooks/leases", "--as", ASKER],
		HUB_ENV,
	);
	expect(ask.code).toBe(2);
	expect(hits).toBe(before);
});

test("--hub without policy refuses before any write", () => {
	const ask = run(
		["consult", "--best", Q_HUB, "--hub", "testhub", "--as", ASKER],
		{
			SUSPENDERS_CONSULT_FEDERATION_FILE: join(HOME, "absent.json"),
		},
	);
	expect(ask.code).toBe(2);
	expect(ask.err).toContain("no consult federation policy");
});
