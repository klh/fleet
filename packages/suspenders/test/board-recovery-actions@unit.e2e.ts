// test/board-recovery-actions@unit.e2e.ts — W2267.3: the distinct recovery
// actions. /api/recover = canonical requeue ONLY; /api/retry = requeue + a
// fresh attempt through the /api/start dispatch path. Pins: schema law (400
// loud), the W970 operator gate on BOTH verbs, duplicate/stale honesty, the
// truthful dispatched:false + dispatchError outcome (dispatch failure never
// fakes running), the dispatched:true claim, and the client contract
// (window.__klhRecovery, pending/error UI, double-click guard, card seam).

import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { ACTIONS_RETRY } from "../hooks/board-html/actions-retry.ts";
import { TASKS } from "../hooks/board-html/tasks.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const f = await boardFixture(0, test.afterAll);
const db = new Database(`${f.HOME}/.cache/claude-governor/governor.db`);
db.run("PRAGMA busy_timeout = 4500");
test.afterAll(() => db.close());
const P = f.MY_PROJ;
function fail(id: string, note: string) {
	db.query(
		"UPDATE work_items SET state = 'FAILED' WHERE project = ? AND id = ?",
	).run(P, id);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fixture', 'work.failed', NULL, ?, NULL)",
	).run(Date.now(), JSON.stringify({ work: id, project: P, note }));
}
function needDecision(id: string, question: string) {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 's-w2267', 'NEED_DECISION', ?, ?, 's-w2267')",
	).run(Date.now(), id, JSON.stringify({ project: P, work: id, question }));
}
const row = (id: string) =>
	db
		.query(
			"SELECT state, owner_sid FROM work_items WHERE project = ? AND id = ?",
		)
		.get(P, id) as { state: string; owner_sid: string | null } | undefined;

test("schema law: malformed bodies 400 loud on both verbs", async () => {
	const noId = await f.post("/api/retry", { project: P });
	expect(noId.status).toBe(400);
	expect(String(noId.json.error)).toContain("id");
	const badForce = await f.post("/api/retry", {
		project: P,
		id: "W1",
		force: "yes",
	});
	expect(badForce.status).toBe(400);
	// /api/recover omits the dispatch-only keys — an agent key is a contract 400
	const stray = await f.post("/api/recover", {
		project: P,
		id: "W1",
		agent: "claude",
	});
	expect(stray.status).toBe(400);
});

test("unknown item 404 on both verbs", async () => {
	expect(
		(await f.post("/api/retry", { project: P, id: "W99998" })).status,
	).toBe(404);
	expect(
		(await f.post("/api/recover", { project: P, id: "W99998" })).status,
	).toBe(404);
});

test("operator gate: open NEED_DECISION 409s BOTH verbs; force recovers", async () => {
	const id = f.addWork("w2267 gated recovery item");
	fail(id, "owner-only work");
	needDecision(id, "owner must configure the relay");
	for (const path of ["/api/retry", "/api/recover"]) {
		const r = await f.post(path, { project: P, id });
		expect(r.status).toBe(409);
		expect(r.json.operatorGated).toBe(true);
	}
	const forced = await f.post("/api/recover", { project: P, id, force: true });
	expect(forced.status).toBe(200);
	expect(row(id)?.state).toBe("READY");
});

test("plain READY item: duplicate/stale retry is an honest 409", async () => {
	const id = f.addWork("w2267 stale retry item");
	const r = await f.post("/api/retry", { project: P, id });
	expect(r.status).toBe(409);
	expect(String(r.json.error)).toContain("retry failed");
});

test("recover requeues ONLY: READY, claim cleared, no dispatch fields", async () => {
	const id = f.addWork("w2267 recover-only item");
	fail(id, "lane died");
	const r = await f.post("/api/recover", { project: P, id });
	expect(r.status).toBe(200);
	expect(r.json).toEqual({ ok: true, item: id, state: "READY" });
	expect(row(id)?.state).toBe("READY");
	expect(row(id)?.owner_sid).toBeNull();
});

test("retry with failed dispatch: truthful READY + dispatched:false + dispatchError", async () => {
	const id = f.addWork("w2267 retry dispatch-fail item");
	fail(id, "lane died");
	// llm:local:1 is a deterministic dispatch refusal (unknown swarm port) —
	// no spawn, no machine dependency
	const r = await f.post("/api/retry", {
		project: P,
		id,
		agent: "llm:local:1",
	});
	expect(r.status).toBe(200);
	expect(r.json.ok).toBe(true);
	expect(r.json.state).toBe("READY");
	expect(r.json.dispatched).toBe(false);
	expect(String(r.json.dispatchError)).toContain("unknown local swarm port");
	expect(row(id)?.state).toBe("READY");
	expect(row(id)?.owner_sid).toBeNull();
});

test("previous executor survives the terminal row: work.claimed `by` fallback", async () => {
	const id = f.addWork("w2267 executor-fallback item");
	// the dead lane's claim record: owner already nulled by the terminal
	// state, so the ONLY retained attempt evidence is the work.claimed event
	// (payload field `by` — the canonical shape assignTask stamps)
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'work', 'work.claimed', NULL, ?, NULL)",
	).run(
		Date.now(),
		JSON.stringify({ work: id, project: P, by: "s-w2267-dead-lane" }),
	);
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, ts) VALUES (?, ?, ?)",
	).run("lane.s-w2267-dead-lane.executor", "llm:local:1", Date.now());
	fail(id, "lane died");
	// no explicit agent: the retry must ride the PREVIOUS executor. The
	// deterministic refusal token proves it — a silent default to the claude
	// stub carrier would have dispatched successfully.
	const r = await f.post("/api/retry", { project: P, id });
	expect(r.status).toBe(200);
	expect(r.json.dispatched).toBe(false);
	expect(String(r.json.dispatchError)).toContain("unknown local swarm port");
});

test("retry happy path: fresh attempt dispatched (claim proof in the browser spec)", async () => {
	const id = f.addWork("w2267 retry dispatch-ok item");
	fail(id, "lane died");
	const r = await f.post("/api/retry", { project: P, id });
	expect(r.status).toBe(200);
	expect(r.json.ok).toBe(true);
	expect(r.json.dispatched).toBe(true);
	expect(typeof r.json.sid).toBe("string");
});

test("client contract: shared helpers, pending UI, guard, card delegation", () => {
	expect(ACTIONS_RETRY).toContain("postJSON('/api/retry'");
	expect(ACTIONS_RETRY).toContain("postJSON('/api/recover'");
	expect(ACTIONS_RETRY).toContain("window.__klhRecovery");
	expect(ACTIONS_RETRY).toContain("aria-busy"); // pending state is visible
	expect(ACTIONS_RETRY).toContain("if (recoveryBusy[k]) return;"); // double-click cannot spawn twice
	// review #100625: postJSON rejects on timeout/network — the unlock must
	// be unconditional or the button/busy key stays locked forever
	expect(ACTIONS_RETRY.match(/\.catch\(/g)?.length).toBe(2);
	// honest toasts: server-read-back state, "requested" not "dispatched"
	expect(ACTIONS_RETRY).toContain("j.state || 'unknown'");
	expect(ACTIONS_RETRY).toContain("fresh attempt requested");
	expect(TASKS).toContain("window.__klhRecovery.retryExecItem"); // card lane seam
	expect(TASKS).toContain("data-retry="); // FAILED card button unchanged
});
