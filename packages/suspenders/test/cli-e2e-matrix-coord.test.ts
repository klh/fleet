// test/cli-e2e-matrix-coord.test.ts — W932: the coord CLI verb matrix. Every
// verb on the registry-generated --help face (W651: help IS the contract)
// runs for real against an isolated governor.db (temp HOME; no network, no
// machine mutations): bus round trips (emit→inbox, broadcast→poll), the
// pause→paused→resume→resumed continuation chain, fact/capsule/lease CRD,
// kb, consult ask→answer→feedback, the knowledge lifecycle (enqueue →
// promote/grade/note → retire/graveyard), governance, gc, metrics, and the
// read-only fleet faces. The final test asserts registry parity — a verb
// added without a matrix scenario fails here.
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

setDefaultTimeout(30_000); // spawn-heavy suite (memory: 5s default in the flake floor)

const fx = cliFixture("coord-matrix");
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const covered = new Set<string>();
const cover = (name: string): void => covered.add(name);
const coord = (...args: string[]) => fx.run("coord.ts", args);
/** knowledge rows live in knowledge.db (govdb-knowledge.ts), not governor.db
 *  — seed through the same subprocess seam with openKnowledgeDb. */
const KDB = join(import.meta.dir, "..", "hooks", "lib", "govdb-knowledge.ts");
const insK = (statement: string, params: unknown[]): void => {
	fx.seed(`const { openKnowledgeDb } = await import(${JSON.stringify(KDB)});
openKnowledgeDb().query(${JSON.stringify(statement)}).run(...${JSON.stringify(params)});
`);
};
const qK = <T>(statement: string): T[] =>
	JSON.parse(
		fx.seed(`const { openKnowledgeDb } = await import(${JSON.stringify(KDB)});
console.log(JSON.stringify(openKnowledgeDb().query(${JSON.stringify(statement)}).all()));
`),
	) as T[];

describe("coord verb matrix — bus round trips", () => {
	test("emit → inbox, broadcast → poll, message → inbox, wait timeout", () => {
		coord("bootstrap", "--as", "lane-a");
		coord("bootstrap", "--as", "lane-b");
		cover("rename");
		expect(coord("rename", "--as", "lane-a", "matrix lane").code).toBe(0);
		cover("emit");
		expect(
			coord("emit", "w932.kind", "--to", "lane-a", "--note", "hello").code,
		).toBe(0);
		cover("inbox");
		const inbox = coord("inbox", "--as", "lane-a");
		expect(inbox.out).toContain("w932.kind");
		cover("broadcast");
		expect(coord("broadcast", "--note", "fleet notice").code).toBe(0);
		cover("poll");
		expect(coord("poll", "--as", "lane-a").out).toContain("BROADCAST");
		cover("message");
		expect(coord("message", "lane-a", "ping text", "--as", "lane-b").code).toBe(
			0,
		);
		const got = coord("inbox", "--as", "lane-a");
		expect(got.out).toContain("ping text");
		cover("wait");
		expect(coord("wait", "--as", "lane-a", "--max-seconds", "1").code).toBe(0);
	});
});

describe("coord verb matrix — pause continuation chain", () => {
	test("pause → paused → resume → resumed round trip", () => {
		coord("bootstrap", "--as", "lane-a");
		cover("capsule");
		// capsule set parses payload flags ONLY in --key=value form (facts.ts
		// scans argv for /^--([\w-]+)=(.+)$/) — the space form silently drops them
		expect(
			coord(
				"capsule",
				"set",
				"--as",
				"lane-a",
				`--checkpoint=${fx.COMMIT}`,
				"--done=did the work",
				"--next=resume here",
			).code,
		).toBe(0);
		cover("pause");
		// --force: no live lane-a process exists in the fixture, so pause would
		// otherwise take the sticky-interrupted path instead of PAUSE_REQUESTED
		expect(coord("pause", "lane-a", "--reason", "hold", "--force").code).toBe(
			0,
		);
		cover("paused");
		expect(coord("paused", "--as", "lane-a", "--sha", fx.COMMIT).code).toBe(0);
		cover("resume");
		expect(coord("resume", "lane-a", "--onto", "cafe123").code).toBe(0);
		cover("resumed");
		expect(coord("resumed", "--as", "lane-a").code).toBe(0);
	});
});

describe("coord verb matrix — fact/capsule/lease/governance CRD", () => {
	test("fact set/get/list/rm round trip", () => {
		cover("fact");
		expect(coord("fact", "set", "w932.key", "v1").code).toBe(0);
		expect(coord("fact", "get", "w932.key").out).toContain("v1");
		expect(coord("fact", "list").out).toContain("w932.key");
		expect(coord("fact", "rm", "w932.key").code).toBe(0);
		const rows = fx.q<{ value: string }>(
			"SELECT value FROM facts WHERE key = 'w932.key'",
		);
		expect(rows).toEqual([]);
	});
	test("capsule get reads the banked face; governance reads+sets mode", () => {
		const got = coord("capsule", "get", "--as", "lane-a");
		expect(got.code).toBe(0);
		expect(got.out.trim().startsWith("{")).toBe(true);
		cover("governance");
		expect(coord("governance").code).toBe(0);
		expect(coord("governance", "solo", "--source", "w932").code).toBe(0);
	});
	test("lease-release frees a seeded lock", () => {
		fx.ins("INSERT INTO locks (path, sid, tool, ts) VALUES (?, ?, ?, ?)", [
			"/w932/probe.ts",
			"lane-a",
			"probe",
			Date.now(),
		]);
		cover("lease-release");
		expect(
			coord("lease-release", "/w932/probe.ts", "--as", "lane-a").out,
		).toContain("lock(s) released");
		const left = fx.q<{ path: string }>(
			"SELECT path FROM locks WHERE path = '/w932/probe.ts'",
		);
		expect(left).toEqual([]);
	});
});

describe("coord verb matrix — kb + gc + wisdom", () => {
	test("kb add → search/list/stats; gc sweeps cleanly", () => {
		cover("kb");
		expect(
			coord("kb", "add", "probe problem", "--solution", "probe solution").code,
		).toBe(0);
		expect(coord("kb", "search", "probe problem").out).toContain("solution");
		expect(coord("kb", "list").out).toContain("probe problem");
		expect(coord("kb", "stats").out).toContain("solutions");
		cover("gc");
		expect(coord("gc").out).toContain("gc:");
		cover("wisdom");
		expect(coord("wisdom").out).toContain("wisdom sweep");
	});
});

describe("coord verb matrix — consult chain", () => {
	test("consult → consults → consult-reply → feedback", () => {
		coord("bootstrap", "--as", "lane-a");
		coord("bootstrap", "--as", "lane-b");
		cover("consult");
		const ask = coord("consult", "lane-b", "how to proceed?", "--as", "lane-a");
		expect(ask.code).toBe(0);
		const question = fx.q<{ id: number }>(
			"SELECT id FROM events WHERE kind = 'consult' AND target = 'lane-b' ORDER BY id DESC LIMIT 1",
		)[0];
		expect(
			fx.q<{ state: string }>(
				`SELECT state FROM direct_message_receipts WHERE event_id = ${question.id} AND sid = 'lane-b'`,
			),
		).toEqual([{ state: "QUEUED" }]);
		cover("consults");
		const list = coord("consults", "--as", "lane-b");
		expect(list.out).toContain("how to proceed?");
		cover("consult-reply");
		expect(coord("consult-reply", "C1", "do this", "--as", "lane-b").code).toBe(
			0,
		);
		const answer = fx.q<{ id: number }>(
			"SELECT id FROM events WHERE kind = 'consult.answer' AND target = 'lane-a' ORDER BY id DESC LIMIT 1",
		)[0];
		expect(
			fx.q<{ state: string }>(
				`SELECT state FROM direct_message_receipts WHERE event_id = ${answer.id} AND sid = 'lane-a'`,
			),
		).toEqual([{ state: "QUEUED" }]);
		coord("poll", "--as", "lane-a");
		expect(coord("inbox", "--as", "lane-a").out).toContain("do this");
		cover("receipt");
		expect(
			JSON.parse(
				coord("receipt", String(answer.id), "--as", "lane-b", "--json").out,
			).state,
		).toBe("SEEN");
		cover("ack");
		expect(coord("ack", String(answer.id), "--as", "lane-b").code).toBe(2);
		expect(coord("ack", String(answer.id), "--as", "lane-a").code).toBe(0);
		expect(coord("ack", String(answer.id), "--as", "lane-a").code).toBe(0);
		expect(coord("inbox", "--as", "lane-a").out).not.toContain("do this");
		const st = coord("consults", "--as", "lane-b");
		expect(st.out).toContain("do this");
		cover("who-knows");
		expect(coord("who-knows", "how to proceed").code).toBe(0);
	});
});

describe("coord verb matrix — knowledge lifecycle", () => {
	test("enqueue queues a row; seeded knowledge walks the lifecycle", () => {
		cover("knowledge-enqueue");
		expect(
			coord("knowledge-enqueue", "--source", "why", "--payload", "lesson one")
				.code,
		).toBe(0);
		const queued = qK<{ id: number }>(
			"SELECT id FROM knowledge_queue WHERE payload LIKE 'lesson one%'",
		);
		expect(queued.length).toBe(1);
		cover("knowledge");
		insK(
			"INSERT INTO knowledge (ts, topic, fact, state) VALUES (?, ?, ?, 'candidate')",
			[Date.now(), "w932 topic", "w932 fact body"],
		);
		const row = qK<{ id: number }>(
			"SELECT id FROM knowledge WHERE topic = 'w932 topic'",
		);
		expect(row.length).toBe(1);
		cover("knowledge-promote");
		expect(coord("knowledge-promote", String(row[0].id)).out).toContain(
			"active",
		);
		cover("knowledge-grade");
		expect(
			coord(
				"knowledge-grade",
				String(row[0].id),
				"--rating",
				"verified",
				"--as",
				"lane-a",
			).code,
		).toBe(0);
		cover("knowledge-note");
		expect(
			coord(
				"knowledge-note",
				String(row[0].id),
				"--what",
				"rechecked",
				"--as",
				"lane-a",
			).code,
		).toBe(0);
		cover("knowledge-retire");
		expect(coord("knowledge-retire", String(row[0].id)).out).toContain(
			"retired",
		);
	});
});

describe("coord verb matrix — knowledge governance verbs", () => {
	test("graveyard/propose/proposals/dispose walk a seeded proposal", () => {
		cover("knowledge-graveyard");
		insK(
			"INSERT INTO knowledge (ts, topic, fact, state) VALUES (?, ?, ?, 'active')",
			[Date.now(), "w932 grave", "grave body"],
		);
		const g = qK<{ id: number }>(
			"SELECT id FROM knowledge WHERE topic = 'w932 grave'",
		);
		expect(
			coord(
				"knowledge-graveyard",
				String(g[0].id),
				"--reason",
				"stale",
				"--as",
				"lane-a",
			).code,
		).toBe(0);
		cover("knowledge-propose");
		expect(coord("knowledge-propose").out).toContain("propose:");
		cover("knowledge-proposals");
		expect(coord("knowledge-proposals").out).toContain("propo");
		cover("knowledge-verify");
		// verify re-hashes source_ref rows; seed one row whose source_ref is a
		// real file (KDB) with its true sha256 so the sweep has something to ✓
		const hash = fx
			.seed(
				`const { createHash } = await import("node:crypto");
const { readFileSync } = await import("node:fs");
console.log(createHash("sha256").update(readFileSync(${JSON.stringify(KDB)}, "utf8")).digest("hex"));`,
			)
			.trim();
		insK(
			"INSERT INTO knowledge (ts, topic, fact, state, source_ref, source_hash) VALUES (?, ?, ?, 'active', ?, ?)",
			[Date.now(), "w932 verify", "verify body", KDB, hash],
		);
		expect(coord("knowledge-verify").code).toBe(0);
		cover("knowledge-curate");
		expect(coord("knowledge-curate").code).toBe(0);
		// W1113: the reprocess checkpoint verb is back on the door face — the
		// dry-run reports honestly on whatever checkpoint state the fixture has.
		cover("knowledge-reprocess");
		const rp = coord("knowledge-reprocess");
		expect(rp.code).toBe(0);
		expect(rp.out).toMatch(/checkpoint current|would requeue/);
	});
	test("dispose dismisses a seeded proposal", () => {
		insK(
			"INSERT INTO knowledge (ts, topic, fact, state) VALUES (?, ?, ?, 'active')",
			[Date.now(), "w932 dispose", "dispose body"],
		);
		const k = qK<{ id: number }>(
			"SELECT id FROM knowledge WHERE topic = 'w932 dispose'",
		);
		insK(
			"INSERT INTO knowledge_proposals (ts, knowledge_id, kind, score, age_days, confidence, reason) VALUES (?, ?, 1, 0.9, 40, 0.5, 'old')",
			[Date.now(), k[0].id],
		);
		const p = qK<{ id: number }>(
			"SELECT id FROM knowledge_proposals WHERE state = 'open'",
		);
		expect(p.length).toBe(1);
		cover("knowledge-dispose");
		expect(
			coord("knowledge-dispose", String(p[0].id), "dismiss", "--as", "lane-a")
				.code,
		).toBe(0);
	});
});

describe("coord verb matrix — read faces + supervisor (read-only)", () => {
	test("targets/events/diff/metrics/hubs/supervisor/project/executor-cv", () => {
		coord("bootstrap", "--as", "lane-a");
		cover("targets");
		expect(coord("targets").code).toBe(0);
		cover("events");
		expect(coord("events", "--last", "3").code).toBe(0);
		cover("diff");
		expect(coord("diff", "--last", "3").code).toBe(0);
		cover("metrics");
		expect(coord("metrics").out).toContain("METRICS");
		cover("hubs");
		expect(coord("hubs").out).toContain("no hubs declared");
		cover("supervisor");
		const sup = coord("supervisor", "status", "--json");
		expect(sup.code).toBe(0);
		expect(sup.out).toContain("supervisors");
		cover("project");
		expect(coord("project", "identity").out).toContain(
			"w932-coord-matrix-repo",
		);
		cover("executor-cv");
		expect(coord("executor-cv").code).toBe(0);
		cover("resume-session");
		expect(
			coord("resume-session", "--as", "lane-c", "--from", "lane-a").code,
		).toBe(0);
	});
});

describe("coord verb matrix — subscribe poll-fallback face", () => {
	test("subscribe without a store URL degrades to poll mode (bounded)", () => {
		coord("bootstrap", "--as", "lane-a");
		cover("subscribe");
		const p = spawnSync(
			"bun",
			[join(BIN, "coord.ts"), "subscribe", "--as", "lane-a"],
			{
				cwd: fx.REPO,
				env: { ...process.env, HOME: fx.HOME },
				encoding: "utf8",
				timeout: 4000,
			},
		);
		expect(String(p.stdout ?? "")).toContain("falling back to poll");
	});
});

describe("coord verb matrix — session bootstrap + read faces", () => {
	test("bootstrap registers the lane; state/fleet/doctor-session read it", () => {
		cover("bootstrap");
		expect(
			coord("bootstrap", "--as", "lane-a", "--name", "probe lane").code,
		).toBe(0);
		cover("state");
		expect(coord("state", "--as", "lane-a").code).toBe(0);
		cover("fleet");
		expect(coord("fleet").code).toBe(0);
		cover("doctor-session");
		expect(coord("doctor-session", "lane-a").code).toBe(0);
		const rows = fx.q<{ sid: string }>(
			"SELECT sid FROM sessions WHERE sid = 'lane-a'",
		);
		expect(rows.length).toBe(1);
		cover("coordinate");
		const noPeerRound = coord(
			"coordinate",
			"--topic",
			"work",
			"--note",
			"matrix coverage",
			"--max-peers",
			"0",
			"--json",
			"--as",
			"lane-a",
		);
		expect(noPeerRound.code).toBe(2);
		expect(noPeerRound.err).toContain("no live peers");
	});
});

describe("coord verb matrix — registry parity (must stay last)", () => {
	test("every verb on the --help door face has a matrix scenario", () => {
		expect(covered).not.toBe(new Set());
		expect([...covered].sort()).toEqual(fx.registryFromHelp("coord.ts").sort());
	});
});

afterAll(() => fx.cleanup());
