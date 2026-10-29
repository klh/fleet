// distill-sync@unit.e2e.ts — the fork G graph transport, end to end: the
// spoke's collect/post/ack/cursor cycle against TWO scratch hubs (serveStub
// origins, a real 0600 roll-key file, the real landing law). No live
// services. Spec-shape law: no TS annotations here.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStub } from "@klh/test-kit";
import { ensureDistillSchema } from "../hooks/lib/knowledge/distill/schema.ts";
import {
	collectGraphWire,
	landGraphWire,
} from "../hooks/lib/knowledge/distill/sync.ts";
import {
	upsertEdge,
	upsertNode,
} from "../hooks/lib/knowledge/distill/graph.ts";
import {
	mintRollKey,
	rollKeyOk,
	ROLL_KEY_HEADER,
} from "../hooks/lib/knowledge/knowledge-roll.ts";
import {
	GRAPH_WIRE_MAX_BYTES,
	postGraph,
	syncOnce,
	validateGraphAck,
} from "../hooks/lib/knowledge/knowledge-sync.ts";

const VOTES_DDL =
	"CREATE TABLE IF NOT EXISTS knowledge_votes (entry_id INTEGER NOT NULL, vote TEXT NOT NULL CHECK (vote IN ('up','down')), lane TEXT NOT NULL, consult_id INTEGER NOT NULL, evidence TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, UNIQUE (entry_id, lane, consult_id))";

const dir = mkdtempSync(join(tmpdir(), "distill-sync-"));
const keysPath = join(dir, "roll-keys.json");
writeFileSync(keysPath, '{"keys":[]}\n', { mode: 0o600 });
const spokeKey = mintRollKey("spoke-1", 24, { path: keysPath }).key;

// scratch dbs: the distill schema on every side (ensureDistillSchema is the
// one DDL source). The spoke db is file-backed so the sync's readonly open
// works — the sibling of the never-created governor.db seam path.
const graphDb = () => {
	const db = new Database(":memory:");
	ensureDistillSchema(db);
	return db;
};

const dbB = graphDb();
const dbC = graphDb();

const spokeGovPath = join(dir, "governor.db");
const spoke = new Database(join(dir, "knowledge.db"));
ensureDistillSchema(spoke);
spoke.exec(VOTES_DDL);
// seed: entry + code + about edge + one up vote — the whole wire vocabulary
const T0 = 1_000;
const entryId = upsertNode(
	spoke,
	{
		kind: "entry",
		key: "knowledge:7",
		label: "lesson: retry-after floor",
		hash: "h1",
		ref: "knowledge:7",
		state: "active",
	},
	T0,
);
const fileId = upsertNode(
	spoke,
	{ kind: "code", key: "packages/x.ts", state: "active" },
	T0,
);
upsertEdge(
	spoke,
	{
		src: entryId,
		dst: fileId,
		type: "about",
		createdBy: "distill",
		state: "active",
	},
	T0 + 1,
);
spoke.run(
	"INSERT INTO knowledge_votes (entry_id, vote, lane, consult_id, evidence, ts) VALUES (7, 'up', 'lane-a', 1, '', ?)",
	T0 + 2,
);

// two stub hub origins. /api/knowledge-ingest + /roll answer the minimal
// batch-matched acks (both pinned in knowledge-sync.test.ts); /graph runs
// the REAL landing law — the sink's exact auth (rollKeyOk against the
// scratch keys file) then landGraphWire — so the assertions read hub rows,
// not stub bookkeeping. failC wedges hub C on /graph (B keeps landing — a
// genuine partial pass).
let failC = false;

const stubHub = (db, wedged = () => false) =>
	serveStub((req, body) => {
		const path = new URL(req.url).pathname;
		if (path === "/api/knowledge-ingest")
			return Response.json({
				ok: true,
				counts: { facts: { landed: 0, dupes: 0, rejected: 0 }, metrics: 0 },
			});
		if (path === "/roll")
			return Response.json({
				ok: true,
				counts: { merged: 0, versions: 0, tombstoned: 0, stale: 0, dupes: 0 },
			});
		if (path !== "/graph") return Response.json({ error: "nf" }, 404);
		if (wedged()) return Response.json({ ok: false, error: "injected" });
		const keyed = rollKeyOk(req.headers.get(ROLL_KEY_HEADER) ?? "", {
			path: keysPath,
		});
		const machine = keyed.ok ? keyed.machine : null;
		if (!machine) return Response.json({ error: "roll key required" }, 403);
		const landed = landGraphWire(db, body?.graph, machine);
		return Response.json(landed, { status: landed.ok ? 200 : 400 });
	});

const hubB = stubHub(dbB);
const hubC = stubHub(dbC, () => failC);

// the 0600 spoke config: both targets roll-capable — the graph rides only
// when rollUrl + rollKeyFile are configured. One 0600 key file serves both
// faces (the stubs never check the ingest token).
const cfgPath = join(dir, "knowledge-sync.json");
const keyFile = join(dir, "spoke-roll.key");
writeFileSync(keyFile, spokeKey, { mode: 0o600 });
writeFileSync(
	cfgPath,
	JSON.stringify({
		localHub: "sync-e2e-devbox",
		targets: [
			{
				url: hubB.url,
				writeTokenFile: keyFile,
				rollUrl: hubB.url,
				rollKeyFile: keyFile,
			},
			{
				url: hubC.url,
				writeTokenFile: keyFile,
				rollUrl: hubC.url,
				rollKeyFile: keyFile,
			},
		],
		policy: { facts: true, metrics: false, metricsSessions: false },
		decantBin: "decant",
	}),
	{ mode: 0o600 },
);
const statePath = join(dir, "sync-state.json");

const pass = () =>
	syncOnce({ configPath: cfgPath, statePath, dbPath: spokeGovPath });

const graphState = () => JSON.parse(readFileSync(statePath, "utf8")).graph;

test.afterAll(() => {
	hubB.close();
	hubC.close();
	spoke.close();
	dbB.close();
	dbC.close();
	rmSync(dir, { recursive: true, force: true });
});

test("two-hub pass: the same delta lands on both hubs under the key-bound origin", async () => {
	const r = await pass();
	for (const o of r.outcomes) expect(o.ok).toBe(true);
	// both hubs: entry (content-keyed), code node, about edge, vote tally —
	// landed under the machine the roll key binds (spoke-1)
	for (const hub of [dbB, dbC]) {
		const entry = hub
			.query("SELECT key, state FROM kg_nodes WHERE kind = 'entry'")
			.get();
		expect(entry.key).toBe("content:h1");
		expect(entry.state).toBe("active");
		expect(
			hub.query("SELECT COUNT(*) AS n FROM kg_nodes WHERE kind = 'code'").get()
				.n,
		).toBe(1);
		expect(hub.query("SELECT state FROM kg_edges").get().state).toBe("active");
		const vote = hub.query("SELECT origin, up FROM kg_peer_votes").get();
		expect(vote.origin).toBe("spoke-1");
		expect(vote.up).toBe(1);
	}
});

test("cursor stamps only on an all-graph-acked pass; the re-send carries zero rows", async () => {
	// after the full pass every row is at/after the stamped cursor
	const cur = graphState();
	expect(cur).toBeGreaterThan(T0);
	// a follow-up pass re-collects nothing (all rows predate the cursor)
	const again = collectGraphWire(spoke, cur, GRAPH_WIRE_MAX_BYTES);
	expect(again.delta.nodes.length + again.delta.edges.length).toBe(0);
	expect(again.truncated).toBe(false);
});

test("a wedged hub retains the cursor; unwedging re-sends and both land once", async () => {
	// a fresh row so the wedge actually has a batch to refuse
	upsertNode(
		spoke,
		{ kind: "code", key: "packages/y.ts", state: "active" },
		T0 + 10,
	);
	failC = true;
	await pass();
	// B landed y.ts, C refused — partial pass: the cursor did NOT stamp
	expect(graphState()).toBe(T0 + 3);
	failC = false;
	await pass();
	// the re-send landed on C; B's copy was already there (idempotent no-op)
	expect(
		dbC
			.query("SELECT COUNT(*) AS n FROM kg_nodes WHERE key = 'packages/y.ts'")
			.get().n,
	).toBe(1);
	expect(
		dbB
			.query("SELECT COUNT(*) AS n FROM kg_nodes WHERE key = 'packages/y.ts'")
			.get().n,
	).toBe(1);
	expect(graphState()).toBe(T0 + 11);
});

test("policy.graph=false ships no graph rows at all", async () => {
	// a row that WOULD ship under the default policy stays machine-local
	upsertNode(
		spoke,
		{ kind: "code", key: "packages/z.ts", state: "active" },
		T0 + 20,
	);
	writeFileSync(
		cfgPath,
		JSON.stringify({
			localHub: "sync-e2e-devbox",
			targets: [
				{
					url: hubB.url,
					writeTokenFile: keyFile,
					rollUrl: hubB.url,
					rollKeyFile: keyFile,
				},
			],
			policy: {
				facts: true,
				metrics: false,
				metricsSessions: false,
				graph: false,
			},
			decantBin: "decant",
		}),
		{ mode: 0o600 },
	);
	await pass();
	expect(
		dbB
			.query("SELECT COUNT(*) AS n FROM kg_nodes WHERE key = 'packages/z.ts'")
			.get().n,
	).toBe(0);
});

test("a byte-budgeted collect truncates with a resumable cursor and converges", () => {
	const db = graphDb();
	upsertNode(
		db,
		{
			kind: "code",
			key: "packages/a.ts",
			label: "L".repeat(400),
		},
		1,
	);
	upsertNode(
		db,
		{ kind: "code", key: "packages/b.ts", label: "L".repeat(400) },
		2,
	);
	const p1 = collectGraphWire(db, 0, 200);
	// one node fit; the second is left behind AT its own t
	expect(p1.truncated).toBe(true);
	expect(p1.delta.nodes.length).toBe(1);
	expect(p1.cursor).toBe(2);
	// resuming from the truncation cursor ships the left-behind row
	const p2 = collectGraphWire(db, p1.cursor, 200);
	expect(p2.truncated).toBe(false);
	expect(p2.delta.nodes.map((n) => n.key)).toEqual(["packages/b.ts"]);
	db.close();
});

test("validateGraphAck negatives: unparseable, non-object, not ok, no counts, bad counters", () => {
	expect(validateGraphAck("nope{{", { sentRows: 1 }).error).toBe(
		"graph ack unparseable",
	);
	expect(validateGraphAck("[]", { sentRows: 1 }).error).toBe(
		"graph ack not an object",
	);
	expect(validateGraphAck('{"ok":false}', { sentRows: 1 }).error).toBe(
		"graph ack not positive: no positive ok flag",
	);
	expect(validateGraphAck('{"ok":true}', { sentRows: 1 }).error).toBe(
		"graph ack carries no counts",
	);
	expect(
		validateGraphAck(
			'{"ok":true,"counts":{"received":1,"applied":"x","rejected":0}}',
			{ sentRows: 1 },
		).error,
	).toBe("graph ack applied counter not numeric");
	expect(
		validateGraphAck(
			'{"ok":true,"counts":{"received":0,"applied":0,"rejected":0}}',
			{ sentRows: 3 },
		).error,
	).toBe("graph ack received 0 of 3 sent rows");
	expect(
		validateGraphAck(
			'{"ok":true,"counts":{"received":1,"applied":0,"rejected":1}}',
			{ sentRows: 2 },
		).error,
	).toBe("graph ack rejects 1 row(s)");
	// a row in neither bucket = a silent hub-side drop — wedges loudly
	expect(
		validateGraphAck(
			'{"ok":true,"counts":{"received":2,"applied":1,"rejected":0}}',
			{ sentRows: 2 },
		).error,
	).toBe("graph ack accounts for 1 of 2 sent rows");
	expect(
		validateGraphAck(
			'{"ok":true,"counts":{"received":2,"applied":2,"rejected":0}}',
			{ sentRows: 2 },
		).ok,
	).toBe(true);
});

test("postGraph: an unconfigured roll target refuses before any network call", async () => {
	const r = await postGraph(
		{ url: hubB.url, writeTokenFile: keyFile },
		{
			delta: { nodes: [], edges: [], votes: [] },
			cursor: 0,
			truncated: false,
		},
	);
	expect(r.ok).toBe(false);
	expect(r.error).toBe("roll not configured");
});
