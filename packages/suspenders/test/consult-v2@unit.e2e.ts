// consult-v2@unit.e2e.ts — hub design phase 4 proofs, fake clock, scratch
// dbs. Interrupt = steer mid-turn with a 180 s per-recipient window (queued +
// coalesced, never downgraded); no ack → re-steer → inbox + asker notice →
// fleet. BTW = one digest line at the next tool boundary, no steer. Oracle
// first: a hit (active or candidate, never drift) answers with zero
// interrupts; candidates carry the unreviewed mark + feedback handle.
// Votes: failed from 2 lanes demotes into review; resolved only counts.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_COORD_CONFIG,
	parseCoordConfig,
} from "../hooks/lib/consult/consult-config.ts";
import {
	deferConsult,
	ensureConsultV2,
	submitConsult,
	tickConsults,
} from "../hooks/lib/consult/consult-delivery.ts";
import { btwDigest, parseRoute } from "../hooks/lib/consult/consult-v2.ts";
import { enforceFeedbackObligation } from "../hooks/lib/consult/feedback-obligation.ts";
import { oracleEligibility } from "../hooks/lib/consult/oracle.ts";
import { applyVote, voteTally } from "../hooks/lib/knowledge/knowledge-votes.ts";

const dir = mkdtempSync(join(tmpdir(), "consult-v2-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cfg = DEFAULT_COORD_CONFIG;
const T0 = 1_800_000_000_000;

function world(oracleHit = null) {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE consult_feedback (consult_id INTEGER PRIMARY KEY, outcome TEXT NOT NULL, evidence TEXT NOT NULL, source TEXT NOT NULL, recorded_at INTEGER NOT NULL)",
	);
	ensureConsultV2(db);
	const clock = { now: T0 };
	const steers = [];
	const events = [];
	const deps = {
		project: "p",
		now: () => clock.now,
		oracle: async () => oracleHit,
		steer: (sid, text) => {
			steers.push({ sid, text, at: clock.now });
			return "accepted";
		},
		emit: (e) => {
			events.push(e);
			return events.length;
		},
	};
	return { db, clock, steers, events, deps };
}

const ask = (asker, to, priority, extra = {}) => ({
	asker,
	route: parseRoute(to),
	question: `q from ${asker} to ${to}`,
	priority,
	blocking: true,
	kind: "ask",
	...extra,
});

test("config: interrupt interval defaults 180 s, bounded 120–300 (drift → defaults)", () => {
	expect(cfg.consult.interrupt.min_interval_s).toBe(180);
	expect(cfg.consult.interrupt.sender_min_interval_s).toBe(180);
	expect(cfg.steer.min_interval_s).toBe(180);
	const warned = [];
	const bad = parseCoordConfig(
		{ consult: { interrupt: { min_interval_s: 3600 } } },
		(m) => warned.push(m),
	);
	expect(bad.consult.interrupt.min_interval_s).toBe(180);
	expect(warned.join("")).toContain("min_interval_s");
	const ok = parseCoordConfig({ consult: { interrupt: { min_interval_s: 300 } } });
	expect(ok.consult.interrupt.min_interval_s).toBe(300);
});

test("high direct consult steers mid-turn; no ack → re-steer → inbox + notice → fleet", async () => {
	const w = world();
	const r = await submitConsult(w.db, ask("asker", "lane-b", "high"), w.deps, cfg);
	expect(r.outcome).toBe("steered");
	expect(w.steers).toHaveLength(1);
	expect(w.steers[0].text).toContain("answer or defer");
	w.clock.now += 179_000;
	expect(tickConsults(w.db, w.deps, cfg).escalated).toEqual([]);
	w.clock.now += 1_000;
	expect(tickConsults(w.db, w.deps, cfg).escalated[0].step).toBe("re-steer");
	expect(w.steers).toHaveLength(2);
	w.clock.now += 180_000;
	expect(tickConsults(w.db, w.deps, cfg).escalated[0].step).toBe("inbox");
	expect(w.events.some((e) => e.kind === "consult.notice" && e.to === "asker")).toBe(true);
	w.clock.now += 180_000;
	expect(tickConsults(w.db, w.deps, cfg).escalated[0].step).toBe("fleet");
	const row = w.db.query("SELECT * FROM consults WHERE id = ?").get(r.id);
	expect(row.route_to).toBe("fleet");
	expect(JSON.parse(row.escalation).map((e) => e.step)).toEqual([
		"re-steer",
		"inbox",
		"fleet",
	]);
	expect(JSON.parse(row.channels).map((c) => c.ch)).toEqual([
		"steer",
		"steer",
		"inbox",
		"fleet",
	]);
});

test("an explicit defer acks the interrupt and stops escalation", async () => {
	const w = world();
	const r = await submitConsult(w.db, ask("asker", "lane-b", "high"), w.deps, cfg);
	expect(deferConsult(w.db, r.id, "lane-b", "mid-migration, after W12", w.deps)).toBeNull();
	w.clock.now += 600_000;
	expect(tickConsults(w.db, w.deps, cfg).escalated).toEqual([]);
});

test("two high consults 30 s apart: one steer now, one coalesced steer at the 180 s boundary", async () => {
	const w = world();
	const a = await submitConsult(w.db, ask("asker-1", "lane-b", "high"), w.deps, cfg);
	w.clock.now += 30_000;
	const b = await submitConsult(w.db, ask("asker-2", "lane-b", "high"), w.deps, cfg);
	w.clock.now += 10_000;
	const c = await submitConsult(w.db, ask("asker-3", "lane-b", "high"), w.deps, cfg);
	expect(a.outcome).toBe("steered");
	expect([b.outcome, c.outcome]).toEqual(["queued", "queued"]);
	expect(b.dueAt).toBe(T0 + 180_000);
	expect(b.class).toBe("interrupt"); // queued, never downgraded to BTW
	w.clock.now = T0 + 179_999;
	tickConsults(w.db, w.deps, cfg);
	expect(w.steers).toHaveLength(1);
	w.clock.now = T0 + 180_000;
	const t = tickConsults(w.db, w.deps, cfg);
	expect(t.steered).toEqual([{ recipient: "lane-b", ids: [b.id, c.id] }]);
	expect(w.steers).toHaveLength(2);
	expect(w.steers[1].text).toContain("coalesced");
});

test("non-blocking high, low direct and fleet broadcast are BTW: one digest, no steer", async () => {
	const w = world();
	const outs = [
		await submitConsult(w.db, ask("a1", "lane-b", "low"), w.deps, cfg),
		await submitConsult(w.db, ask("a2", "fleet", "normal"), w.deps, cfg),
		await submitConsult(
			w.db,
			ask("a3", "lane-b", "high", { blocking: false }),
			w.deps,
			cfg,
		),
	];
	expect(outs.map((o) => o.outcome)).toEqual(["btw", "btw", "btw"]);
	expect(w.steers).toHaveLength(0);
	const lines = w.events
		.filter((e) => e.kind === "consult.btw")
		.map((e, i) => `  #${100 + i} ${e.source} consult.btw  consult=${e.payload.consult}`);
	const shown = btwDigest([...lines, "  #200 coord work.landed  W9"]);
	expect(shown).toHaveLength(2);
	expect(shown[0]).toMatch(/^BTW digest \(3\): /);
	expect(shown[1]).toContain("work.landed");
});

test("oracle first: an active verified hit answers with zero interrupts", async () => {
	const hit = {
		hit: { kind: "knowledge", id: 7, state: "active", trust: "verified", fact: "flush first" },
		tier: "trusted",
	};
	const w = world(hit);
	const r = await submitConsult(w.db, ask("asker", "lane-b", "high"), w.deps, cfg);
	expect(r.outcome).toBe("knowledge");
	expect(w.steers).toHaveLength(0);
	expect(r.text).toContain("trust: active · hash verified · entry k#7");
	expect(r.text).toContain("--feedback resolved|failed");
	const row = w.db.query("SELECT answered_by, trust FROM consults WHERE id = ?").get(r.id);
	expect(row.answered_by).toBe("knowledge");
	expect(row.trust).toContain("trusted");
});

test("a candidate answers marked unreviewed; drift, retired and unverified-active never answer", async () => {
	expect(oracleEligibility({ kind: "knowledge", state: "candidate", trust: "verified" })).toBe("unreviewed");
	expect(oracleEligibility({ kind: "knowledge", state: "candidate", trust: "unverified" })).toBe("unreviewed");
	expect(oracleEligibility({ kind: "knowledge", state: "candidate", trust: "drift" })).toBeNull();
	expect(oracleEligibility({ kind: "knowledge", state: "retired", trust: "verified" })).toBeNull();
	expect(oracleEligibility({ kind: "knowledge", state: "active", trust: "unverified" })).toBeNull();
	const hit = {
		hit: { kind: "knowledge", id: 9, state: "candidate", trust: "verified", fact: "use --force" },
		tier: "unreviewed",
	};
	const w = world(hit);
	const r = await submitConsult(w.db, ask("asker", "lane-b", "high"), w.deps, cfg);
	expect(r.outcome).toBe("knowledge");
	expect(w.steers).toHaveLength(0);
	expect(r.text).toContain("trust: candidate · unreviewed");
	expect(r.text).toContain(`report: coord consult-reply ${r.cid} --feedback`);
	// a drifted candidate is filtered before the oracle returns → delivery
	const w2 = world(null);
	const d = await submitConsult(w2.db, ask("asker", "lane-b", "high"), w2.deps, cfg);
	expect(d.outcome).toBe("steered");
});

test("votes: failed from 2 lanes demotes into review; resolved only counts; failed re-delivers", async () => {
	const kb = new Database(join(dir, "knowledge.db"));
	const up = applyVote(kb, { entryId: 9, vote: "up", lane: "l0", consultId: 1, evidence: "worked" }, 2);
	expect(up.demoted).toBe(false);
	expect(voteTally(kb, 9)).toEqual({ up: 1, down: 0, downLanes: 0 });
	const d1 = applyVote(kb, { entryId: 9, vote: "down", lane: "l1", consultId: 2, evidence: "still stuck" }, 2);
	expect(d1.demoted).toBe(false);
	const d2 = applyVote(kb, { entryId: 9, vote: "down", lane: "l2", consultId: 3, evidence: "wrong flag" }, 2);
	expect(d2.demoted).toBe(true);
	const review = kb
		.query("SELECT kind, reference, text, state FROM kev_review WHERE reference = 'k#9'")
		.get();
	expect(review.kind).toBe("downvote");
	expect(review.state).toBe("pending");
	expect(review.text).toContain("still stuck");
	expect(review.text).toContain("wrong flag");
	kb.close();
	// re-delivery skips the oracle and routes through interrupt/BTW
	const hit = { hit: { kind: "knowledge", id: 9, state: "candidate", trust: "verified" }, tier: "unreviewed" };
	const w = world(hit);
	const re = await submitConsult(
		w.db,
		ask("asker", "lane-b", "high", { skipOracle: true }),
		w.deps,
		cfg,
	);
	expect(re.outcome).toBe("steered");
});

test("work done warns on an unreported knowledge answer; blocks only when configured", async () => {
	const hit = { hit: { kind: "knowledge", id: 3, state: "active", trust: "verified" }, tier: "trusted" };
	const w = world(hit);
	const r = await submitConsult(w.db, ask("lane-x", "lane-b", "normal"), w.deps, cfg);
	const logs = [];
	const orig = console.log;
	console.log = (m) => logs.push(String(m));
	let owed = [];
	try {
		owed = enforceFeedbackObligation(
			w.db,
			"W1",
			{ owner_sid: "lane-x", created_at: T0 - 1 },
			(m) => {
				throw new Error(m);
			},
			false,
		);
	} finally {
		console.log = orig;
	}
	expect(owed.map((o) => o.id)).toEqual([r.id]);
	expect(logs[0]).toContain(`coord consult-reply ${r.cid} --feedback resolved|failed`);
	expect(() =>
		enforceFeedbackObligation(
			w.db,
			"W1",
			{ owner_sid: "lane-x", created_at: T0 - 1 },
			(m) => {
				throw new Error(m);
			},
			true,
		),
	).toThrow("require_on_done");
	w.db.run("INSERT INTO consult_feedback VALUES (?, 'resolved', 'ok', 'lane-x', 1)", [r.id]);
	expect(
		enforceFeedbackObligation(w.db, "W1", { owner_sid: "lane-x", created_at: T0 - 1 }, () => {
			throw new Error("no");
		}, true),
	).toEqual([]);
});
