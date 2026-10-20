// coord-coordinate.test.ts — W977.1: the bounded supervisor coordination
// trigger and its WS consult contract. Recipe: coord-reads.test.ts (temp
// HOME, every CLI run in a bun subprocess; the db is the fixture HOME's
// governor.db). The seed resolves projectIdentity() in the same cwd so the
// CLI's project scoping sees the seeded rows.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const LIB = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"supervisor-coordination.ts",
);
const home = mkdtempSync(join(tmpdir(), "suspenders-coord-coordinate-test-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const runIn = (code: string): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

const runCli = (
	args: string[],
	env: Record<string, string> = {},
): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(["bun", COORD, ...args], {
		env: { ...process.env, HOME: home, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};

const sql = <T>(statement: string): T[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all()));
`),
	);

// seed: asker + live/idle peers, an external connector, a paused lane, and
// the asker's claim/READY state — one project, resolved in-cwd
runIn(`
const { openGovernorDb, projectIdentity } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const P = projectIdentity();
const now = Date.now();
const ses = db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, ?, ?, ?, 'RUNNING')");
ses.run("w977-asker", P, "lane", now, now);
ses.run("w977-live", P, "lane", now, now + 2);
ses.run("w977-idle", P, "lane", now, now - 10_000);
ses.run("w977-ext", P, "external", now, now + 3);
ses.run("w977-paused", P, "lane", now, now + 4);
db.query("INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.w977-paused.state', 'PAUSED', 'test', 1, ?)").run(now);
db.query("INSERT INTO work_items (project, id, title, state, owner_sid, created_at, updated_at) VALUES (?, 'w977-ready', 'ready item', 'READY', NULL, ?, ?)").run(P, now, now);
db.query("INSERT INTO work_items (project, id, title, state, owner_sid, created_at, updated_at) VALUES (?, 'w977-claim', 'claimed item', 'CLAIMED', 'w977-asker', ?, ?)").run(P, now, now);
db.close();
`);

describe("coord coordinate — wire format + gate units (W977.1)", () => {
	test("wire format: questionFor/topicOf round-trip, bad topics null", async () => {
		const m = await import(LIB);
		const q = m.questionFor("capacity", "2 ready 0 lanes");
		expect(q).toBe("coordinate/capacity: 2 ready 0 lanes");
		expect(m.topicOf(q)).toBe("capacity");
		expect(m.topicOf("plain question")).toBe(null);
		expect(m.topicOf("coordinate/bogus: x")).toBe(null);
	});

	test("gate: classify=false fires without Kev", async () => {
		const m = await import(LIB);
		const d = await m.coordinationGate({
			topic: "capacity",
			note: "x",
			snapshot: { claims: [], ready: 0 },
			classify: false,
		});
		expect(d.fired).toBe(true);
		expect(d.via).toBe("bounds");
	});
});

// kev-class systemone stub: port-0 in-process serve, typed choice answer
const kevStub = (choice: "ask" | "skip") =>
	Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				model: "kev-stub",
				answers: {
					d: {
						type: "choice",
						choice,
						confidence: 0.9,
						probabilities:
							choice === "ask"
								? { ask: 0.9, skip: 0.1 }
								: { skip: 0.9, ask: 0.1 },
					},
				},
				usage: { input_tokens: 5, output_tokens: 1 },
				latency_ms: 1,
			}),
	});

describe("coord coordinate — Kev gate (W977.1 --classify)", () => {
	test("skip suppresses, ask fires, model surfaces", async () => {
		const m = await import(LIB);
		const saved = process.env.SUSPENDERS_KEV_URL;
		const srv = kevStub("skip");
		process.env.SUSPENDERS_KEV_URL = `http://127.0.0.1:${srv.port}`;
		const skip = await m.coordinationGate({
			topic: "capacity",
			note: "premature",
			snapshot: { claims: [], ready: 0 },
			classify: true,
		});
		expect(skip.fired).toBe(false);
		expect(skip.via).toBe("kev-skip");
		srv.stop(true);
		const ask = kevStub("ask");
		process.env.SUSPENDERS_KEV_URL = `http://127.0.0.1:${ask.port}`;
		const go = await m.coordinationGate({
			topic: "capacity",
			note: "crunch",
			snapshot: { claims: [], ready: 5 },
			classify: true,
		});
		expect(go.fired).toBe(true);
		expect(go.via).toBe("kev");
		expect(go.model).toBe("kev-stub");
		if (saved === undefined) delete process.env.SUSPENDERS_KEV_URL;
		else process.env.SUSPENDERS_KEV_URL = saved;
	});
});

describe("coord coordinate — bounded rounds (W977.1)", () => {
	test("fires to live peers only; external + paused + self excluded", () => {
		const r = runCli([
			"coordinate",
			"--topic",
			"capacity",
			"--note",
			"2 ready 0 lanes",
			"--json",
			"--as",
			"w977-asker",
		]);
		expect(r.code).toBe(0);
		const j = JSON.parse(r.out.trim());
		expect(j.ok).toBe(true);
		expect(j.via).toBe("bounds");
		expect(j.peers.sort()).toEqual(["w977-idle", "w977-live"]);
		expect(j.consults.length).toBe(2);
		expect(j.snapshot).toEqual({ claims: ["w977-claim"], ready: 1 });
		const rows = sql<{ expert_sid: string; question: string }>(
			"SELECT expert_sid, question FROM consults WHERE question LIKE 'coordinate/%' ORDER BY id",
		);
		expect(rows.map((x) => x.expert_sid)).toEqual(["w977-live", "w977-idle"]);
		expect(rows[0]?.question).toBe("coordinate/capacity: 2 ready 0 lanes");
		const receipts = sql<{ state: string }>(
			"SELECT r.state FROM events e JOIN direct_message_receipts r ON r.event_id = e.id WHERE e.kind = 'consult' AND e.source = 'w977-asker' ORDER BY e.id",
		);
		expect(receipts).toEqual([{ state: "QUEUED" }, { state: "QUEUED" }]);
	});

	test("singleflight: repeat ask replays the OPEN round, no new consults", () => {
		const before =
			sql<{ n: number }>(
				"SELECT COUNT(*) AS n FROM consults WHERE question LIKE 'coordinate/%'",
			)[0]?.n ?? 0;
		const r = runCli([
			"coordinate",
			"--topic",
			"capacity",
			"--note",
			"2 ready 0 lanes",
			"--json",
			"--as",
			"w977-asker",
		]);
		expect(r.code).toBe(0);
		const j = JSON.parse(r.out.trim());
		expect(j.replay).toBe(true);
		expect(j.consults.length).toBe(1);
		const after =
			sql<{ n: number }>(
				"SELECT COUNT(*) AS n FROM consults WHERE question LIKE 'coordinate/%'",
			)[0]?.n ?? 0;
		expect(after).toBe(before);
	});

	test("new topic = new round (not a replay of capacity)", () => {
		const r = runCli([
			"coordinate",
			"--topic",
			"work",
			"--note",
			"who holds shared-scope claims",
			"--json",
			"--as",
			"w977-asker",
		]);
		expect(r.code).toBe(0);
		const j = JSON.parse(r.out.trim());
		expect(j.replay).toBe(false);
		expect(j.consults.length).toBe(2);
	});

	test("--max-peers caps the fan to the most-recent peer", () => {
		const r = runCli([
			"coordinate",
			"--topic",
			"claims",
			"--note",
			"conflict check",
			"--max-peers",
			"1",
			"--json",
			"--as",
			"w977-asker",
		]);
		expect(r.code).toBe(0);
		const j = JSON.parse(r.out.trim());
		expect(j.consults.length).toBe(1);
		const row = sql<{ expert_sid: string }>(
			"SELECT expert_sid FROM consults WHERE question LIKE 'coordinate/claims:%' ORDER BY id DESC LIMIT 1",
		)[0];
		expect(row?.expert_sid).toBe("w977-live");
	});

	test("rate cap: post-closure churn dies once the window's rounds are spent", () => {
		// close the capacity round — an OPEN round replays (singleflight), so
		// the cap only binds NEW rounds (distinct topic+note) past the 3rd
		runCli([
			"consult-reply",
			"C1",
			"2 free lanes on my side",
			"--as",
			"w977-live",
		]);
		runCli(["consult-reply", "C2", "one lane on my side", "--as", "w977-idle"]);
		const r = runCli([
			"coordinate",
			"--topic",
			"capacity",
			"--note",
			"fourth ask inside the window",
			"--json",
			"--as",
			"w977-asker",
		]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("rate cap");
	});

	test("no live peers: refusal events and exits 2", () => {
		// --max-peers 0 = an explicit no-peer round: the same refusal path a
		// closed-down fleet takes, without cross-process session-row surgery
		// (a spawned CLI can read a pre-update page set even after a TRUNCATE
		// checkpoint — never gate a test on read-after-write across processes)
		const r = runCli(
			[
				"coordinate",
				"--topic",
				"capacity",
				"--note",
				"anybody there",
				"--max-peers",
				"0",
				"--as",
				"w977-asker",
			],
			{ SUSPENDERS_COORD_RATE_MAX: "99" },
		);
		expect(r.code).toBe(2, r.err);
		expect(r.err).toContain("no live peers");
		const ev = sql<{ payload: string }>(
			"SELECT payload FROM events WHERE kind = 'consult' AND payload LIKE '%no live peers%' ORDER BY id DESC LIMIT 1",
		)[0];
		expect(ev?.payload).toContain("REFUSED");
	});

	test("round trip: peer replies, asker's bounded wait face shows the answer", () => {
		// the contract's answer leg rides the STANDARD consult-reply flow; the
		// asker's wait face is the same renderer subscribe pushes through
		const reply = runCli([
			"consult-reply",
			"C3",
			"2 free lanes here",
			"--as",
			"w977-live",
		]);
		expect(reply.code).toBe(0, reply.err);
		const w = runCli([
			"wait",
			"--kinds",
			"consult.answer",
			"--max-seconds",
			"3",
			"--as",
			"w977-asker",
		]);
		expect(w.code).toBe(0);
		expect(w.out).toContain("consult.answer");
		expect(w.out).toContain("2 free lanes here");
	});

	test("--classify with Kev down degrades open (round fires)", () => {
		const r = runCli(
			[
				"coordinate",
				"--topic",
				"claims",
				"--note",
				"conflict check two",
				"--classify",
				"--json",
				"--as",
				"w977-asker",
			],
			{
				SUSPENDERS_KEV_URL: "http://127.0.0.1:9",
				SUSPENDERS_COORD_RATE_MAX: "99",
			},
		);
		expect(r.code).toBe(0, r.err);
		const j = JSON.parse(r.out.trim());
		expect(j.via).toBe("bounds");
	});
});
