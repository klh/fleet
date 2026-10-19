// fleet-board-decisions.test.ts — decision fork/advise lifecycle
// (docs/decisions-api.md), split from fleet-board.test.ts by the
// 1500-line law (W456). Own factory fixture — scratch HOME, OS-chosen
// port — so one bun test run keeps the family files isolated.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

type Row = Record<string, unknown>;
const {
	TOKEN,
	HOME,
	REPO,
	run,
	sleep,
	getData,
	getDecisions,
	post,
	fork,
	addWork,
	BASE,
} = await boardFixture(0, afterAll);

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

	test("W667: registry-dead target classifies stale (sessions row RUNNING), answer routes owner ruling", async () => {
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"board-lane",
				"--note",
				"stale lane fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const rec = fork(await getDecisions(), "stale lane fork");
		expect(rec).toBeDefined();
		expect(rec.owner_actionable).toBe(false); // sessions face: RUNNING
		// register the target as a dead dispatch lane (dead pid, no transcript)
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(REPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{ sid: "board-lane", item: "W1", pid: 999999999, host: hostname() },
			]),
		);
		// the 3s registry memo may serve the pre-registration read — retry
		let staleRec: Row | undefined;
		for (let i = 0; i < 20; i++) {
			await sleep(300);
			staleRec = fork(await getDecisions(), "stale lane fork");
			if (staleRec.owner_actionable === true) break;
		}
		expect(staleRec?.owner_actionable).toBe(true);
		expect(staleRec?.owner_reason).toBe("target-dead");
		// the owner ruling resolves without a lane ack
		const ans = await post("/api/answer", {
			id: staleRec?.id,
			to: staleRec?.target,
			note: "owner decides: proceed",
			token: staleRec?.answer_token,
		});
		expect(ans.status).toBe(200);
		expect(ans.json.ruling).toBe(true);
		expect(fork(await getDecisions(), "stale lane fork").state).toBe(
			"ANSWERED",
		);
	});

	test("W667: /api/advise dedupe rides the in-flight stamp; the child clears it on its terminal write", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"advise dedupe fork",
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "advise dedupe fork");
		expect(rec).toBeDefined();
		// first POST: no stamp → spawns the detached child (started:true)
		const first = await post("/api/advise", { id: rec.id });
		expect(first.status).toBe(200);
		expect(first.json.started).toBe(true);
		// the child runs against dead upstreams (:1) — it exits writing the
		// error fact AND clearing the requested stamp (its terminal write)
		const gdb = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		gdb.run("PRAGMA busy_timeout = 4000");
		let cleared = false;
		for (let i = 0; i < 100; i++) {
			const stamp = gdb
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${rec.id}.requested`) as { value: string } | null;
			const err = gdb
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${rec.id}.error`) as { value: string } | null;
			if (err && !stamp) {
				cleared = true;
				break;
			}
			await sleep(100);
		}
		expect(cleared).toBe(true);
		gdb.close();
		// a stamped fork: the next POST rides in-flight, no second spawn
		const sdb = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		sdb.run("PRAGMA busy_timeout = 4000");
		sdb
			.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, 'in-flight', 'fleet-board', 1, ?)",
			)
			.run(`advice.${rec.id}.requested`, Date.now());
		const second = await post("/api/advise", { id: rec.id });
		expect(second.json.ok).toBe(true);
		expect(second.json.inFlight).toBe(true);
		expect(second.json.started).toBe(false);
		const pending = fork(await getDecisions(), "advise dedupe fork");
		expect(pending.advicePending).toBe("in-flight");
		sdb.close();
	});

	test("a lane's unique owned work links a decision without a --work payload", async () => {
		const wid = addWork("decision linkage without payload work");
		const sid = "decision-link-lane";
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.query(
			"UPDATE work_items SET owner_sid = ?, state = 'CLAIMED' WHERE id = ?",
		).run(sid, wid);
		db.close();
		expect(
			run("coord.ts", ["bootstrap", "--as", sid, "--role", "worker"]).code,
		).toBe(0);
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				sid,
				"--note",
				"link this fork to its owner",
				"--as",
				sid,
			]).code,
		).toBe(0);
		const rec = fork(await getDecisions(), "link this fork to its owner");
		expect(rec.task_id).toBe(wid);
		expect(rec.task_title).toBe("decision linkage without payload work");
	});

	test("a completed lane links historical decisions from its claim event", async () => {
		const wid = addWork("historical decision claim link");
		const sid = "completed-decision-lane";
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		const item = db
			.query("SELECT project FROM work_items WHERE id = ?")
			.get(wid) as { project: string };
		db.query(
			"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'work', 'work.claimed', ?)",
		).run(
			Date.now(),
			JSON.stringify({ project: item.project, work: wid, by: sid }),
		);
		db.close();
		expect(
			run("coord.ts", ["bootstrap", "--as", sid, "--role", "worker"]).code,
		).toBe(0);
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				sid,
				"--note",
				"historical link after owner cleared",
				"--as",
				sid,
			]).code,
		).toBe(0);
		const rec = fork(
			await getDecisions(),
			"historical link after owner cleared",
		);
		expect(rec.task_id).toBe(wid);
		expect(rec.task_title).toBe("historical decision claim link");
	});

	test("re-evaluation acknowledges promptly and reports terminal model error", async () => {
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"board-lane",
				"--note",
				"evaluate failure fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const rec = fork(await getDecisions(), "evaluate failure fork");
		const started = await fetch(`${BASE}/api/decisions/${rec.id}/evaluate`, {
			method: "POST",
			headers: { "x-klh-write-token": TOKEN },
		});
		expect(started.status).toBe(202);
		const first = await started.json();
		expect(first).toMatchObject({ ok: true, started: true, running: true });
		let status: { running: boolean; error: string | null } | null = null;
		for (let i = 0; i < 50; i++) {
			const feed = await (
				await fetch(`${BASE}/api/decisions/${rec.id}/evals`)
			).json();
			status = feed.status;
			if (status && !status.running) break;
			await sleep(100);
		}
		expect(status?.running).toBe(false);
		expect(status?.error).toBeTruthy();
	});

	test("W798: same-anchor OPEN forks collapse — primary dup_count, member dup_of", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"scrub rule for /p/a/wake.ts:42?",
			"--as",
			"board-lane",
		]);
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"scrub rule for /p/a/wake.ts:99?",
			"--as",
			"board-lane",
		]);
		const feed = await getDecisions();
		const all = feed.decisions.filter((d: Row) =>
			String(d.question).includes("wake.ts"),
		);
		expect(all.length).toBe(2);
		const primary = all.find((d: Row) => d.dup_count);
		const member = all.find((d: Row) => d.dup_of);
		expect(primary?.dup_count).toBe(2);
		expect(member?.dup_of).toBe(primary?.id);
	});

	test("W798: OPEN fork on a DONE task ages out to CANCELLED on sync", async () => {
		const wid = addWork("done-task fork");
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"still needed?",
			`--work=${wid}`,
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "still needed?");
		expect(rec).toBeDefined();
		const wdb = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		wdb.run("PRAGMA busy_timeout = 4000");
		wdb.run(
			"UPDATE work_items SET state = 'DONE', updated_at = ? WHERE id = ?",
			[Date.now(), wid],
		);
		wdb.close();
		const after = fork(await getDecisions(), "still needed?");
		expect(after.state).toBe("CANCELLED");
	});

	test("W798: one POST with ids[] resolves the class per-member", async () => {
		for (const ln of ["1", "7"]) {
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"board-lane",
				"--note",
				`scrub rule for /q/b/paths.ts:${ln}?`,
				"--as",
				"board-lane",
			]);
		}
		const feed = await getDecisions();
		const pair = feed.decisions.filter((d: Row) =>
			String(d.question).includes("paths.ts"),
		);
		expect(pair.length).toBe(2);
		const primary = pair.find((d: Row) => d.dup_count);
		const member = pair.find((d: Row) => d.dup_of);
		expect(primary && member).toBeTruthy();
		const res = await post("/api/answer", {
			ids: [primary.id, member.id],
			note: "one ruling covers the class",
		});
		expect(res.status).toBe(200);
		expect(res.json.ruling).toBe(true);
		expect(res.json.applied.length).toBe(2);
		const h = await getDecisions();
		expect(fork(h, "scrub rule for /q/b/paths.ts:1?").state).toBe("ANSWERED");
		expect(fork(h, "scrub rule for /q/b/paths.ts:7?").state).toBe("ANSWERED");
	});
});
