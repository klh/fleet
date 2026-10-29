// distill-run@unit.e2e.ts — fork G: the idle distiller's run contract.
// Idle gate (busy → no run; quiet → run), preemption between units with
// resume from the oldest unvisited entries, stalest-first ordering, the
// hash-changed boost, the overdue (starvation) report, the token budget,
// the kill switch, run rows + NDJSON + the bus event, config refusal.
import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	distillDefaults,
	loadDistillConfig,
} from "../hooks/lib/knowledge/distill/config.ts";
import { runOnce } from "../hooks/lib/knowledge/distill/runner.ts";
import { syncEntries } from "../hooks/lib/knowledge/distill/sink.ts";
import {
	distillStatus,
	renderStatus,
} from "../hooks/lib/knowledge/distill/status.ts";
import {
	jobCoverage,
	pickBatch,
	stampVisit,
} from "../hooks/lib/knowledge/distill/visits.ts";
import { addEntry, knowledgeDb, world } from "./fixtures/distill-world.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "distill-run-"));

const seed = (db, n) => {
	const ids = [];
	for (let i = 0; i < n; i++)
		ids.push(
			addEntry(db, {
				topic: `entry ${i}`,
				fact: `fact number ${i} about packages/buckle/src/router-walk.ts`,
			}),
		);
	return ids;
};

test("config: absent block = disabled defaults; malformed block is refused loudly", () => {
	expect(loadDistillConfig({}).config.enabled).toBe(false);
	expect(loadDistillConfig({}).issue).toBeNull();
	const bad = loadDistillConfig({
		knowledge: { distill: { enabled: true, batch: 0 } },
	});
	expect(bad.config.enabled).toBe(false);
	expect(bad.issue).toContain("batch");
	const ok = loadDistillConfig({
		knowledge: { distill: { enabled: true, batch: 7 } },
	});
	expect(ok.config.batch).toBe(7);
	expect(ok.config.model_group).toBe("glm-5.3");
});

test("idle gate: busy → skipped with no work; quiet → run", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	seed(db, 3);
	const w = world(db, { logDir: dir });
	try {
		w.signals.liveLanes = 2;
		const busy = await runOnce(w.deps, { jobs: ["extract"] });
		expect(busy.outcome).toBe("skipped");
		expect(busy.items).toBe(0);
		expect(db.query("SELECT COUNT(*) AS n FROM distill_visits").get().n).toBe(
			0,
		);
		w.signals.liveLanes = 0;
		w.signals.interactiveAt = Date.now();
		expect((await runOnce(w.deps, { jobs: ["extract"] })).outcome).toBe(
			"skipped",
		);
		w.signals.interactiveAt = Date.now() - 60 * 60_000;
		const quiet = await runOnce(w.deps, { jobs: ["extract"] });
		expect(quiet.outcome).toBe("ok");
		expect(quiet.items).toBe(3);
		// one run row + one NDJSON line + one bus event per run
		expect(db.query("SELECT COUNT(*) AS n FROM distill_runs").get().n).toBe(3);
		const lines = readFileSync(join(dir, "distill-runs.jsonl"), "utf8")
			.trim()
			.split("\n");
		expect(lines.length).toBe(3);
		expect(JSON.parse(lines[2]).items).toBe(3);
		expect(
			w.events.filter((e) => e.kind === "knowledge.distilled").length,
		).toBe(3);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pressure probe configured but unreadable reads as busy", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	seed(db, 1);
	const w = world(db, {
		logDir: dir,
		cfg: { pressure: { url: "http://127.0.0.1:9/metrics", max: 2 } },
	});
	try {
		w.signals.pressure = null;
		const r = await runOnce(w.deps, { jobs: ["extract"] });
		expect(r.outcome).toBe("skipped");
		w.signals.pressure = 1;
		expect((await runOnce(w.deps, { jobs: ["extract"] })).outcome).toBe("ok");
		w.signals.pressure = 3;
		expect((await runOnce(w.deps, { jobs: ["extract"] })).outcome).toBe(
			"skipped",
		);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preemption mid-job stops at once; the next window resumes from the oldest unvisited", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	seed(db, 5);
	const w = world(db, { logDir: dir, cfg: { batch: 5 } });
	try {
		// read 1 = the run gate; reads 2..3 = before units 1..2; read 4 → busy
		w.signals.busyAfter = 3;
		const r = await runOnce(w.deps, { jobs: ["extract"] });
		expect(r.outcome).toBe("preempted");
		expect(r.preempted).toBe(true);
		expect(r.items).toBe(2);
		const visited = db
			.query("SELECT entry_id FROM distill_visits WHERE job = 'extract'")
			.all()
			.map((x) => x.entry_id);
		expect(visited.length).toBe(2);
		expect(visited).not.toContain(r.stoppedEntry);
		const row = db
			.query(
				"SELECT outcome, stopped_job, stopped_entry, preempted FROM distill_runs ORDER BY id DESC LIMIT 1",
			)
			.get();
		expect(row).toEqual({
			outcome: "preempted",
			stopped_job: "extract",
			stopped_entry: r.stoppedEntry,
			preempted: 1,
		});
		// resume: the picker leads with the three never-visited entries, the
		// preempted entry first among them (oldest by id order on a tie)
		const next = pickBatch(db, w.cfg, "extract", 5).map((n) => n.id);
		expect(next.slice(0, 3).sort()).toEqual(
			db
				.query(
					"SELECT id FROM kg_nodes WHERE kind = 'entry' AND id NOT IN (SELECT entry_id FROM distill_visits) ORDER BY id",
				)
				.all()
				.map((x) => x.id),
		);
		expect(next[0]).toBe(r.stoppedEntry);
		w.signals.busyAfter = undefined;
		const again = await runOnce(w.deps, { jobs: ["extract"] });
		expect(again.outcome).toBe("ok");
		expect(
			db
				.query("SELECT COUNT(*) AS n FROM distill_visits WHERE job = 'extract'")
				.get().n,
		).toBe(5);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stalest-first ordering; a changed hash jumps the queue; overdue is reported", () => {
	const db = knowledgeDb();
	const [a, b, c] = seed(db, 3);
	syncEntries(db);
	const cfg = distillDefaults({ enabled: true, min_revisit_h: 0 });
	const node = (kid) =>
		db
			.query("SELECT id, hash, usage FROM kg_nodes WHERE ref = ?")
			.get(`knowledge:${kid}`);
	const now = Date.now();
	const H = 3_600_000;
	stampVisit(db, node(a).id, "extract", node(a), "ok", now - 10 * H);
	stampVisit(db, node(b).id, "extract", node(b), "ok", now - 1 * H);
	// c never visited → first; then a (10h) → then b (1h)
	expect(pickBatch(db, cfg, "extract", 3, now).map((n) => n.id)).toEqual([
		node(c).id,
		node(a).id,
		node(b).id,
	]);
	// b's content changes: +72h hash boost puts it ahead of a
	db.query(
		"UPDATE knowledge SET fact = 'rewritten fact', updated_at = ? WHERE id = ?",
	).run(now, b);
	syncEntries(db);
	expect(pickBatch(db, cfg, "extract", 3, now).map((n) => n.id)).toEqual([
		node(c).id,
		node(b).id,
		node(a).id,
	]);
	// starvation guard: max_age 1 day; a visited 2 days ago is overdue
	const strict = { ...cfg, max_age_days: 1 };
	stampVisit(db, node(a).id, "extract", node(a), "ok", now - 48 * H);
	const cov = jobCoverage(db, strict, "extract", now);
	expect(cov.eligible).toBe(3);
	expect(cov.neverVisited).toBe(1);
	expect(cov.overdue).toBe(1);
	expect(cov.coverage).toBeCloseTo(33.3, 1);
	const st = distillStatus(
		db,
		strict,
		{ issue: null, pausePath: "/nonexistent", decant: false },
		now,
	);
	expect(st.overdue).toBeGreaterThanOrEqual(1);
	expect(renderStatus(st)).toContain("OVERDUE");
});

test("the token budget stops a run mid-job", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	for (let i = 0; i < 4; i++)
		addEntry(db, {
			topic: `retry budget lesson ${i}`,
			fact: "buckle retry budget caps failover hops per upstream window",
		});
	const w = world(db, {
		logDir: dir,
		cfg: { token_budget_per_day: 150 },
		chat: {
			answer: () => '{"contradicts": false, "reason": "same"}',
			tokens: 100,
		},
	});
	try {
		expect((await runOnce(w.deps, { jobs: ["crosslink"] })).outcome).toBe("ok");
		expect(
			db
				.query("SELECT COUNT(*) AS n FROM kg_edges WHERE type = 'related'")
				.get().n,
		).toBeGreaterThan(2);
		const r = await runOnce(w.deps, { jobs: ["contradiction"] });
		expect(r.outcome).toBe("budget");
		expect(r.stoppedJob).toBe("contradiction");
		expect(w.up.chat.requests.length).toBe(2);
		const spent = db.query("SELECT tokens FROM distill_budget").get().tokens;
		expect(spent).toBe(200);
		// the next run refuses before any chat call
		const again = await runOnce(w.deps, { jobs: ["contradiction"] });
		expect(again.outcome).toBe("budget");
		expect(w.up.chat.requests.length).toBe(2);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("kill switch, disabled config and an upstream 429 all stop without retrying", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	for (let i = 0; i < 3; i++)
		addEntry(db, {
			topic: `cooldown lesson ${i}`,
			fact: "one shared cooldown per upstream stops the herd",
		});
	const chat = { answer: () => "{}", tokens: 5, status: 429 };
	const w = world(db, { logDir: dir, chat });
	try {
		writeFileSync(w.deps.pausePath, "x");
		expect((await runOnce(w.deps)).outcome).toBe("paused");
		rmSync(w.deps.pausePath);
		expect(
			(await runOnce({ ...w.deps, cfg: { ...w.cfg, enabled: false } })).outcome,
		).toBe("disabled");
		await runOnce(w.deps, { jobs: ["crosslink"] });
		const r = await runOnce(w.deps, { jobs: ["contradiction"] });
		expect(r.outcome).toBe("ok:notes");
		// one call, then the job stopped for the run — no retry storm
		expect(w.up.chat.requests.length).toBe(1);
		expect(existsSync(w.deps.logPath)).toBe(true);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
