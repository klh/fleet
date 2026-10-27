// test/w244-reprocess.test.ts — W244 parser-change reprocess checkpoint:
// done queue rows carry the sha256 of the distill prompt that processed them
// (complete()); when the active prompt hash moves, reprocessCheck() re-enqueues
// the older-parser rows EXACTLY ONCE (one tx: marks + requeues + checkpoint),
// payload-less legacy rows are marked-and-skipped, a poisoned reprocess copy
// re-arms its parent, and the worker tick + coord knowledge-reprocess drive
// the same port. Temp HOME + import bust — the knowledge.test.ts isolation
// pattern (w159-settle.test.ts shape).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w244-"));
// restore before afterAll cleanup: the rest of the suite shares this
// process — a leaked fixture HOME rides later spawns' {...process.env}
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const { openGovernorDb, openKnowledgeDb } = await import(
	`../hooks/lib/govdb/govdb.ts?w244=${encodeURIComponent(HOME)}`
);
const { SqliteKnowledgeStore } = await import(
	`../hooks/lib/knowledge/sqlite-store.ts?w244=${encodeURIComponent(HOME)}`
);
const { currentPromptHash } = await import(
	`../hooks/lib/knowledge/prompt-policy.ts?w244=${encodeURIComponent(HOME)}`
);

const GOV = join(HOME, ".cache", "claude-governor", "governor.db");
const KDB = join(HOME, ".cache", "claude-governor", "knowledge.db");
mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });

// the parser: a temp prompt file the tests rewrite between phases
const PROMPT = join(HOME, "knowledgeworker.md");
const writePrompt = (v: string): void => {
	writeFileSync(PROMPT, `w244 parser v${v}: distill honestly. ${v}${v}${v}.`);
	process.env.KNOWLEDGE_PROMPT_FILE = PROMPT;
};

// nuke both dbs; return a fresh governor handle (the store's events bus)
function fresh(): Database {
	for (const f of [GOV, KDB])
		for (const suffix of ["", "-wal", "-shm"])
			rmSync(f + suffix, { force: true });
	return openGovernorDb();
}

const store = (): InstanceType<typeof SqliteKnowledgeStore> =>
	new SqliteKnowledgeStore(openKnowledgeDb(), openGovernorDb());

// seed one done row directly (state/payload/prompt-hash under test control)
function seedDone(payload: string, promptHash: string | null): number {
	const db = openKnowledgeDb();
	const r = db
		.query(
			"INSERT INTO knowledge_queue (ts, source, payload, state, attempts, prompt_hash) VALUES (?, 'w244-seed', ?, 'done', 1, ?)",
		)
		.run(Date.now(), payload, promptHash);
	return Number(r.lastInsertRowid);
}

const qrow = (id: number): Record<string, unknown> | undefined => {
	const db = openKnowledgeDb();
	return db.query("SELECT * FROM knowledge_queue WHERE id = ?").get(id) as
		| Record<string, unknown>
		| undefined;
};

// the distill stub: one fixed item per call (the dedupe gate absorbs repeats)
const stub = Bun.serve({
	port: 0,
	fetch(): Promise<Response> {
		return Response.json({
			choices: [
				{
					message: {
						content: JSON.stringify([
							{
								topic: "w244 reprocess probe",
								fact: "w244 marker: the checkpoint re-ingests exactly once.",
								confidence: 0.8,
								domain: "suspenders",
								area: "queue",
								origin_kind: "lesson",
								origin_system: null,
							},
						]),
					},
				},
			],
		});
	},
});

const PKG = join(import.meta.dir, "..");

// async spawn: sync would block the loop that answers the stub (W362)
async function runWorker(): Promise<{ out: string; code: number }> {
	const p = Bun.spawn(["bun", "hooks/bin/knowledge-worker.ts", "--once"], {
		cwd: PKG,
		env: {
			...process.env,
			HOME,
			SUSPENDERS_BUCKLE_URL: `http://127.0.0.1:${stub.port}`,
			SUSPENDERS_BUCKLE_TOKEN: "bksk_reprocess_fixture",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(p.stdout).text();
	return { out, code: await p.exited };
}

function runCli(args: string[]): { out: string; code: number } {
	const p = Bun.spawnSync(
		["bun", "hooks/bin/coord.ts", "knowledge-reprocess", ...args],
		{
			cwd: PKG,
			env: { ...process.env, HOME },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { out: p.stdout.toString(), code: p.exitCode };
}

afterAll(() => {
	process.env.HOME = REAL_HOME;
	stub.stop(true);
	rmSync(HOME, { recursive: true, force: true });
});

test("migration: queue columns + checkpoint table exist on open", () => {
	fresh();
	const db = openKnowledgeDb();
	const cols = (
		db.query("PRAGMA table_info(knowledge_queue)").all() as { name: string }[]
	).map((c) => c.name);
	expect(cols).toContain("prompt_hash");
	expect(cols).toContain("reprocessed_at");
	expect(cols).toContain("reprocess_of");
	const ck = db
		.query(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_checkpoint'",
		)
		.get();
	expect(ck).toBeDefined();
});

test("complete() stamps prompt_hash and keeps the payload", async () => {
	fresh();
	writePrompt("1");
	const s = store();
	const db = openKnowledgeDb();
	const r = db
		.query(
			"INSERT INTO knowledge_queue (ts, source, payload, state, attempts) VALUES (?, 'w244-c', 'payload stays', 'queued', 0)",
		)
		.run(Date.now());
	const id = Number(r.lastInsertRowid);
	expect(await s.claim(id)).not.toBeNull();
	await s.complete(id, { written: [7], skipped: [] }, null, "w244-test");
	const row = qrow(id);
	expect(row?.state).toBe("done");
	expect(row?.payload).toBe("payload stays");
	expect(row?.prompt_hash).toBe(currentPromptHash());
});

test("dry-run counts without writing", async () => {
	fresh();
	writePrompt("2");
	const cur = currentPromptHash();
	seedDone("older payload", "deadbeef");
	seedDone("", "deadbeef");
	const rep = await store().reprocessCheck(cur, false);
	expect(rep.requeued).toBe(1);
	expect(rep.skippedNoPayload).toBe(1);
	expect(rep.marked).toBe(2); // would-count: both scanned rows would be marked
	expect(rep.checkpoint).toBeNull();
	const db = openKnowledgeDb();
	const n = db
		.query("SELECT COUNT(*) AS n FROM knowledge_queue WHERE state = 'queued'")
		.get() as { n: number };
	expect(n.n).toBe(0);
	expect(db.query("SELECT prompt_hash FROM queue_checkpoint").get()).toBeNull(); // dry-run never advances (empty table → null row)
});

test("apply requeues exactly once; re-apply no-ops", async () => {
	fresh();
	writePrompt("2");
	const cur = currentPromptHash();
	const parent = seedDone("reprocess me w244", "deadbeef");
	const rep = await store().reprocessCheck(cur, true);
	expect(rep.advanced).toBe(true);
	expect(rep.requeued).toBe(1);
	expect(rep.marked).toBe(1);
	expect(qrow(parent)?.reprocessed_at).not.toBeNull();
	const db = openKnowledgeDb();
	const copy = db
		.query("SELECT state, payload FROM knowledge_queue WHERE reprocess_of = ?")
		.get(parent) as { state: string; payload: string } | null;
	expect(copy?.state).toBe("queued");
	expect(copy?.payload).toBe("reprocess me w244");
	const ck = db
		.query("SELECT prompt_hash FROM queue_checkpoint WHERE id = 1")
		.get() as { prompt_hash: string };
	expect(ck.prompt_hash).toBe(cur);
	expect(
		openGovernorDb()
			.query("SELECT payload FROM events WHERE kind = 'knowledge.reprocess'")
			.get(),
	).toBeDefined();
	const rep2 = await store().reprocessCheck(cur, true);
	expect(rep2.advanced).toBe(false);
	expect(rep2.requeued).toBe(0); // exactly-once: the second pass no-ops
});

test("poisoned reprocess copy re-arms the parent", async () => {
	fresh();
	writePrompt("2");
	const cur = currentPromptHash();
	const parent = seedDone("arm me w244", "deadbeef");
	await store().reprocessCheck(cur, true);
	const db = openKnowledgeDb();
	const copy = db
		.query("SELECT id FROM knowledge_queue WHERE reprocess_of = ?")
		.get(parent) as { id: number };
	await store().fail(copy.id, "distill exploded", true);
	expect(qrow(parent)?.reprocessed_at).toBeNull(); // re-armed
	expect((qrow(copy.id) as { state: string }).state).toBe("failed");
	// the next evolution re-ingests the parent, not the dead copy
	writePrompt("3");
	const rep = await store().reprocessCheck(currentPromptHash(), true);
	expect(rep.requeued).toBe(1);
	const copies = db
		.query("SELECT id FROM knowledge_queue WHERE reprocess_of = ?")
		.all(parent) as { id: number }[];
	expect(copies.length).toBe(2);
});

test("worker: a prompt edit between drains requeues the archived source once", async () => {
	fresh();
	writePrompt("1");
	// enqueue through the CLI (subprocess): an in-process enqueueKnowledge would
	// resolve its govdb binding through the shared module cache — another test
	// file's plain govdb instance pins a DIFFERENT temp HOME first (w159 loads
	// alphabetically before w244) and the row lands in the wrong temp db.
	const enq = Bun.spawnSync(
		[
			"bun",
			"hooks/bin/coord.ts",
			"knowledge-enqueue",
			"--source",
			"w244-worker",
			"--payload",
			"w244 worker probe source text",
			"--as",
			"w244-test",
		],
		{
			cwd: PKG,
			env: { ...process.env, HOME },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(enq.exitCode).toBe(0);
	const w1 = await runWorker();
	expect(w1.code).toBe(0);
	expect(w1.out).toContain("1 written, 0 skipped");
	const db = openKnowledgeDb();
	const first = db
		.query(
			"SELECT id, prompt_hash FROM knowledge_queue WHERE state = 'done' ORDER BY id",
		)
		.get() as { id: number; prompt_hash: string };
	expect(first.prompt_hash).toBe(currentPromptHash());
	// evolve the parser and drain again — the tick fires the checkpoint
	writePrompt("2");
	const w2 = await runWorker();
	expect(w2.out).toContain("reprocess — 1 requeued");
	const rows = db
		.query(
			"SELECT id, prompt_hash, reprocess_of FROM knowledge_queue WHERE state = 'done' ORDER BY id",
		)
		.all() as { id: number; prompt_hash: string; reprocess_of: number }[];
	expect(rows.length).toBe(2);
	expect(rows[1].reprocess_of).toBe(rows[0].id);
	expect(rows[1].prompt_hash).toBe(currentPromptHash());
});

test("coord knowledge-reprocess: dry-run, apply, then current", () => {
	fresh();
	writePrompt("4");
	seedDone("cli probe payload", "deadbeef");
	const dry = runCli([]);
	expect(dry.out).toContain("would requeue 1");
	const apply = runCli(["--apply"]);
	expect(apply.out).toContain("1 requeued");
	const again = runCli(["--apply"]);
	expect(again.out).toContain("checkpoint current");
});
