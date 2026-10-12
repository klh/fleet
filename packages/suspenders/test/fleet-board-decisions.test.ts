// fleet-board-decisions.test.ts — decision fork/advise lifecycle
// (docs/decisions-api.md), split from fleet-board.test.ts by the
// 1500-line law (W456). Own factory fixture — scratch HOME, OS-chosen
// port — so one bun test run keeps the family files isolated.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { boardFixture } from "./helpers/board-fixture.ts";

type Row = Record<string, unknown>;
const { HOME, run, getData, getDecisions, post, fork, addWork } =
	await boardFixture(0, afterAll);

describe("decision lifecycle (docs/decisions-api.md)", () => {
	test("fork survives inbox ack; answer rotates the token; replay 200, stale 409, then ack", async () => {
		expect(
			run("coord.ts", ["bootstrap", "--as", "board-lane", "--role", "worker"])
				.code,
		).toBe(0);
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"board-lane",
				"--scope",
				"W9",
				"--note",
				"ship or hold?",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const rec = fork(await getDecisions(), "ship or hold?");
		expect(rec).toBeDefined();
		expect(rec.state).toBe("OPEN");
		expect(rec.asked_by).toBe("board-lane");
		expect(rec.delivery).toBe("DELIVERED");
		expect(typeof rec.answer_token).toBe("string");
		// the regression: the recipient reads their inbox — cursor moves past
		// the fork, but the fork must stay OPEN on the board
		expect(run("coord.ts", ["inbox", "--as", "board-lane", "--ack"]).code).toBe(
			0,
		);
		expect(fork(await getDecisions(), "ship or hold?").state).toBe("OPEN");
		// answer requires the answer_token the client read
		const ans = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "ship it",
			token: rec.answer_token,
		});
		expect(ans.status).toBe(200);
		expect(ans.json.ok).toBe(true);
		const answered = fork(await getDecisions(), "ship or hold?");
		expect(answered.state).toBe("ANSWERED");
		expect(answered.answer_note).toBe("ship it");
		expect(answered.answer_to).toBe("board-lane");
		expect(answered.answered_ts).toBeGreaterThan(0);
		expect(answered.answer_token).not.toBe(rec.answer_token); // rotated
		// idempotent replay: same note on the answered fork → 200 replay:true
		const replay = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "ship it",
			token: rec.answer_token,
		});
		expect(replay.status).toBe(200);
		expect(replay.json.ok).toBe(true);
		expect(replay.json.replay).toBe(true);
		// stale view (another tab answered differently since) → 409 stale
		const stale = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "actually hold",
			token: rec.answer_token,
		});
		expect(stale.status).toBe(409);
		expect(stale.json.error).toBe("stale");
		// ACKNOWLEDGED heuristic: lane checkpoint after answered_ts, token rotates again
		const tok2 = answered.answer_token;
		expect(
			run("coord.ts", [
				"emit",
				"checkpoint",
				"--as",
				"board-lane",
				"--note",
				"shipping",
			]).code,
		).toBe(0);
		const acked = fork(await getDecisions(), "ship or hold?");
		expect(acked.state).toBe("ACKNOWLEDGED");
		expect(acked.ack_ts).toBeGreaterThan(0);
		expect(acked.answer_token).not.toBe(tok2);
	});

	test("dismiss = CANCELLED, idempotent, refused after an answer; answering a dismissed fork is stale", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"dismiss me",
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "dismiss me");
		expect(rec).toBeDefined();
		for (let i = 0; i < 2; i++) {
			const ack = await post("/api/ack", { id: rec.id });
			expect(ack.status).toBe(200);
			expect(ack.json.ok).toBe(true); // idempotent
		}
		expect(fork(await getDecisions(), "dismiss me").state).toBe("CANCELLED");
		// answering a dismissed fork with the pre-dismiss token is stale
		const late = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "too late",
			token: rec.answer_token,
		});
		expect(late.status).toBe(409);
		// monotonic: an ANSWERED fork cannot be dismissed
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"answer then keep",
			"--as",
			"board-lane",
		]);
		const rec2 = fork(await getDecisions(), "answer then keep");
		expect(rec2).toBeDefined();
		expect(
			(
				await post("/api/answer", {
					id: rec2.id,
					to: "board-lane",
					note: "kept",
					token: rec2.answer_token,
				})
			).status,
		).toBe(200);
		const dismiss = await post("/api/ack", { id: rec2.id });
		expect(dismiss.status).toBe(409);
		expect(dismiss.json.error).toBe("already answered");
	});

	test("W487: owner-needed classification and dead targets resolve as owner rulings, never Send-to-lane", async () => {
		// classified owner-needed: target alive, the card is still owner-actionable
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"board-lane",
				"--note",
				"owner ruling fork",
				"--as",
				"board-lane",
				"--classification=owner-needed",
			]).code,
		).toBe(0);
		const rec = fork(await getDecisions(), "owner ruling fork");
		expect(rec).toBeDefined();
		expect(rec.owner_actionable).toBe(true);
		expect(rec.owner_reason).toBe("owner-needed");
		const ans = await post("/api/answer", {
			id: rec.id,
			to: rec.target,
			note: "hold until W500",
			token: rec.answer_token,
		});
		expect(ans.status).toBe(200);
		expect(ans.json.ok).toBe(true);
		expect(ans.json.ruling).toBe(true);
		const ruled = fork(await getDecisions(), "owner ruling fork");
		expect(ruled.state).toBe("ANSWERED");
		expect(ruled.answer_to).toBe("board-lane");
		// the ruling is an owner record on the bus — no lane target on the event
		const wdb = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		wdb.run("PRAGMA busy_timeout = 4000");
		const ev = wdb
			.query(
				"SELECT target, payload FROM events WHERE kind = 'ANSWER' AND json_extract(payload, '$.decision') = ? ORDER BY id DESC LIMIT 1",
			)
			.get(String(rec.id)) as { target: string | null; payload: string };
		wdb.close();
		expect(ev.target).toBeNull();
		expect((JSON.parse(ev.payload) as Row).ruling).toBe("owner");

		// dead target: session not RUNNING → owner-actionable with reason target-dead
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"board-lane",
				"--note",
				"dead target fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const rec2 = fork(await getDecisions(), "dead target fork");
		expect(rec2).toBeDefined();
		const kdb = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		kdb.run("PRAGMA busy_timeout = 4000");
		kdb.run("UPDATE sessions SET state = 'DEAD' WHERE sid = 'board-lane'");
		kdb.close();
		const rec2dead = fork(await getDecisions(), "dead target fork");
		expect(rec2dead.owner_actionable).toBe(true);
		expect(rec2dead.owner_reason).toBe("target-dead");
		const ans2 = await post("/api/answer", {
			id: rec2.id,
			to: rec2.target,
			note: "owner decides: proceed",
			token: rec2.answer_token,
		});
		expect(ans2.status).toBe(200);
		expect(ans2.json.ruling).toBe(true);
		expect(fork(await getDecisions(), "dead target fork").state).toBe(
			"ANSWERED",
		);
		// restore so later tests see board-lane alive
		const rdb = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		rdb.run("PRAGMA busy_timeout = 4000");
		rdb.run("UPDATE sessions SET state = 'RUNNING' WHERE sid = 'board-lane'");
		rdb.close();
	});

	test("v1 DISMISSED rows fold into CANCELLED on sync", async () => {
		// a NEED event with no target never backfills — host for a legacy row
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--note",
				"legacy fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		const ev = db
			.query(
				"SELECT id FROM events WHERE kind = 'NEED_DECISION' AND target IS NULL ORDER BY id DESC LIMIT 1",
			)
			.get() as { id: number };
		db.run(
			"INSERT OR IGNORE INTO decisions (event_id, target, state, created_at) VALUES (?, 'board-lane', 'DISMISSED', ?)",
			ev.id,
			Date.now(),
		);
		db.close();
		const rec = fork(await getDecisions(), "legacy fork");
		expect(rec.state).toBe("CANCELLED");
		expect(rec.asked_by).toBe("board-lane"); // enrichment backfilled from the event
	});

	test("task_title joins from work_items; work supersede cancels the open fork", async () => {
		const wid = addWork("superseded target");
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"hold the rework?",
			`--work=${wid}`,
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "hold the rework?");
		expect(rec).toBeDefined();
		expect(rec.task_id).toBe(wid);
		expect(rec.task_title).toBe("superseded target");
		expect(
			run("coord.ts", [
				"emit",
				"work.superseded",
				`--work=${wid}`,
				"--as",
				"work",
			]).code,
		).toBe(0);
		const after = fork(await getDecisions(), "hold the rework?");
		expect(after.state).toBe("CANCELLED");
	});

	test("delivery: live target DELIVERED, unknown target FAILED", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"ghost-lane",
			"--note",
			"nobody home",
			"--as",
			"board-lane",
		]);
		const feed = await getDecisions();
		expect(fork(feed, "nobody home").delivery).toBe("FAILED");
		expect(fork(feed, "dismiss me").delivery).toBe("DELIVERED");
	});

	test("/api/decisions shape: options, age, label, global + per-project counts; /api/data drops decisions", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"pick one",
			`--options=[{"label":"queue","tradeoff":"slower start"},{"label":"stream","tradeoff":"more memory"}]`,
			"--as",
			"board-lane",
		]);
		const feed = await getDecisions();
		const rec = fork(feed, "pick one");
		expect(rec.options).toEqual([
			{ label: "queue", tradeoff: "slower start" },
			{ label: "stream", tradeoff: "more memory" },
		]);
		expect(rec.age_s).toBeGreaterThanOrEqual(0);
		expect(typeof rec.asked_by_label).toBe("string");
		expect(rec.created_ts).toBeGreaterThan(0);
		const open = feed.decisions.filter((d: Row) => d.state === "OPEN");
		expect(feed.count).toBe(open.length);
		expect(feed.byProject[open[0].project]).toBeGreaterThan(0);
		const sum = Object.values(feed.byProject).reduce(
			(a, b) => (a as number) + (b as number),
			0,
		) as number;
		expect(sum).toBe(feed.count);
		const d = await getData();
		expect(typeof d.decisionsTs).toBe("number");
		expect(d.needs).toBeUndefined();
	});
});
