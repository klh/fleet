// fleet-board-apiv3.test.ts — board api v3 surface (/api/tasks,
// /api/task, /api/executors; docs/board-api.md), split from
// fleet-board.test.ts by the 1500-line law (W456). Own factory fixture
// — scratch HOME, OS-chosen port.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { boardFixture } from "./helpers/board-fixture.ts";

type Row = Record<string, unknown>;
const { HOME, REPO, BASE, run, q, getDecisions, post, fork, addWork } =
	await boardFixture(0, afterAll);

describe("board api v3 (docs/board-api.md)", () => {
	// the temp repo has a bare .git dir (no refs) — projectIdentity() falls
	// back to the cwd realpath, /var/folders symlinks resolve to /private/var
	const proj = realpathSync(REPO);

	test("/api/work-summary counts dependency-blocked READY separately", async () => {
		const prior = await (await fetch(`${BASE}/api/work-summary`)).json();
		const root = addWork("summary prerequisite");
		const dependent = addWork("summary blocked dependent");
		expect(run("work.ts", ["block", dependent, "--on", root]).code).toBe(0);
		const next = await (await fetch(`${BASE}/api/work-summary`)).json();
		expect(next.ok).toBe(true);
		expect(next.counts.ready).toBe(prior.counts.ready + 1);
		expect(next.counts.blocked).toBe(prior.counts.blocked + 1);
		expect(Number.isFinite(next.counts.done)).toBe(true);
	});

	test("/api/tasks: contract shape, newest activity first, project filter, open_decisions, owner_label", async () => {
		const w1 = addWork("tasks demo alpha", ["--scope", "ta"]);
		const w2 = addWork("tasks demo beta", [
			"--scope",
			"tb",
			"--requires",
			"shell",
		]);
		// the shell-requiring item needs a capable session on record
		expect(
			run("coord.ts", [
				"bootstrap",
				"--as",
				"board-lane",
				"--role",
				"worker",
				"--caps",
				"shell",
			]).code,
		).toBe(0);
		expect(run("work.ts", ["take", w2, "--as", "board-lane"]).code).toBe(0);
		// claim intent → owner_label (claim.ts validates live transcripts, which
		// a temp HOME lacks — seed the row directly, same recipe as the v1 rows)
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		db.run(
			"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts) VALUES ('board-lane', 'ta', 'tasks lane', 0, ?)",
			Date.now(),
		);
		db.close();
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"tasks fork?",
			`--work=${w1}`,
			"--as",
			"board-lane",
		]);
		const all = await (await fetch(`${BASE}/api/tasks`)).json();
		expect(all.ok).toBe(true);
		expect(all.projects).toContain(proj);
		const feed = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(feed.ok).toBe(true);
		expect(feed.tasks.length).toBeGreaterThan(1);
		for (const t of feed.tasks) {
			expect(t.project).toBe(proj);
			expect(Object.keys(t).sort()).toEqual([
				"age_s",
				"blocked_by",
				"created_at_utc",
				"executor",
				"failure_note",
				"id",
				"locality",
				"model",
				"open_decisions",
				"origin",
				"owner_label",
				"owner_sid",
				"parent_id",
				"project",
				"requires",
				"scope",
				"signal",
				"spend",
				"state",
				"tag",
				"tag_color",
				"tail",
				"title",
				"unblocked_by",
				"updated_at_utc",
				"waiting_on",
			]);
		}
		const alpha = feed.tasks.find((t: Row) => t.id === w1);
		const beta = feed.tasks.find((t: Row) => t.id === w2);
		// newest activity first: beta was taken after alpha was added
		expect(feed.tasks.findIndex((t: Row) => t.id === w2)).toBeLessThan(
			feed.tasks.findIndex((t: Row) => t.id === w1),
		);
		expect(beta.state).toBe("CLAIMED");
		expect(beta.owner_sid).toBe("board-lane");
		expect(beta.owner_label).toBe("tasks lane"); // claim intent, not the raw sid
		expect(beta.requires).toBe("shell");
		expect(beta.scope).toBe("tb");
		expect(beta.open_decisions).toBe(0);
		expect(typeof beta.age_s).toBe("number");
		expect(alpha.owner_sid).toBeNull();
		expect(alpha.owner_label).toBeNull();
		expect(alpha.open_decisions).toBe(1); // the fork emitted with --work
		// the `all` literal returns every project's items
		const everything = await (
			await fetch(`${BASE}/api/tasks?project=all`)
		).json();
		expect(everything.tasks.find((t: Row) => t.id === w1)).toBeDefined();
		// superseding removes the item from the feed
		expect(run("work.ts", ["supersede", w2, "--by", w1]).code).toBe(0);
		const after = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(after.tasks.find((t: Row) => t.id === w2)).toBeUndefined();
	});

	test("/api/tasks: done→ready auto-start — unblocked_by flags the freed dependent", async () => {
		const w1 = addWork("auto-start root", ["--scope", "asr"]);
		const w2 = addWork("auto-start dependent", ["--scope", "asd"]);
		run("work.ts", ["block", w2, "--on", w1]);
		// done emits work.ready; the flag rides the newest unblock event
		const tw = run("work.ts", ["take", w1, "--as", "w50-tester"]);
		expect(tw.code).toBe(0);
		const tok = /claim token: ([0-9a-f]{48})/.exec(tw.out)?.[1];
		expect(
			run("work.ts", [
				"done",
				w1,
				"--as",
				"w50-tester",
				"--sha",
				"abc1234",
				...(tok ? ["--token", tok] : []),
			]).code,
		).toBe(0);
		const feed = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		const dep = feed.tasks.find((t: Row) => t.id === w2);
		expect(dep.state).toBe("READY");
		expect(dep.unblocked_by).toBe(w1);
		// the drawer's task object shares the shape ("…as above" in board-api.md)
		const drawer = await (
			await fetch(`${BASE}/api/task?project=${q(proj)}&id=${w2}`)
		).json();
		expect(drawer.task.unblocked_by).toBe(w1);
		// self-clearing: once the freed item is claimed, the flag drops
		expect(run("work.ts", ["take", w2, "--as", "w50-tester"]).code).toBe(0);
		const later = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(later.tasks.find((t: Row) => t.id === w2).unblocked_by).toBeNull();
	});

	test("/api/tasks: dependency splines — blocked_by (unmet deps) + waiting_on (SHATTERED wait set)", async () => {
		const wA = addWork("splines dep", ["--scope", "splA"]);
		const wB = addWork("splines dependent", ["--scope", "splB"]);
		expect(run("work.ts", ["block", wB, "--on", wA]).code).toBe(0);
		const wP = addWork("splines parent", ["--scope", "splP"]);
		expect(
			run("work.ts", [
				"split",
				wP,
				"spline child one",
				"spline child two",
				"--reason",
				"independent-scopes",
			]).code,
		).toBe(0);
		const feed = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		const dep = feed.tasks.find((t: Row) => t.id === wB);
		expect(dep.blocked_by).toEqual([wA]);
		const parent = feed.tasks.find((t: Row) => t.id === wP);
		expect(parent.state).toBe("SHATTERED");
		const kids = feed.tasks
			.filter((t: Row) => t.parent_id === wP)
			.map((t: Row) => t.id)
			.sort();
		expect(kids).toEqual([...parent.waiting_on].sort());
		expect(kids.length).toBe(2);
		// a dep row removed → the blocked edge drops out of the feed
		expect(run("work.ts", ["unblock", wB, "--on", wA]).code).toBe(0);
		const feed2 = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		const dep2 = feed2.tasks.find((t: Row) => t.id === wB);
		expect(dep2.blocked_by).toEqual([]);
	});

	test("/api/task: 404 shape for a missing id; events + decisions linkage, newest first", async () => {
		const miss = await fetch(`${BASE}/api/task?project=${q(proj)}&id=NOPE`);
		expect(miss.status).toBe(404);
		expect((await miss.json()).ok).toBe(false);
		const wid = addWork("detail demo", ["--scope", "td"]);
		run("coord.ts", [
			"emit",
			"checkpoint",
			"--scope",
			wid,
			"--note",
			"scope-tied note",
			"--as",
			"board-lane",
		]);
		run("coord.ts", [
			"emit",
			"checkpoint",
			`--work=${wid}`,
			"--note",
			"work-tied note",
			"--as",
			"board-lane",
		]);
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"detail fork?",
			`--work=${wid}`,
			"--as",
			"board-lane",
		]);
		const r = await (
			await fetch(`${BASE}/api/task?project=${q(proj)}&id=${wid}`)
		).json();
		expect(r.ok).toBe(true);
		expect(r.projects).toContain(proj);
		expect(r.task.id).toBe(wid);
		expect(r.task.title).toBe("detail demo");
		expect(r.task.open_decisions).toBe(1);
		expect(r.events.length).toBeGreaterThanOrEqual(4); // added + scope checkpoint + work checkpoint + fork
		const ids = r.events.map((e: Row) => e.id);
		expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids); // newest first
		for (const e of r.events) {
			expect(Object.keys(e).sort()).toEqual([
				"id",
				"kind",
				"note",
				"sha",
				"source",
				"ts",
			]);
			expect(e.ts).toBeGreaterThan(0);
		}
		expect(r.events.map((e: Row) => e.note)).toContain("scope-tied note"); // scope match
		expect(r.events.map((e: Row) => e.note)).toContain("work-tied note"); // payload.work match
		const dec = r.decisions.find((d: Row) => d.question === "detail fork?");
		expect(dec.state).toBe("OPEN");
		expect(dec.answer_note).toBeNull();
		expect(Object.keys(dec).sort()).toEqual([
			"answer_note",
			"event_id",
			"question",
			"state",
		]);
	});

	test("/api/task includes the full failure reason shown on its card", async () => {
		const wid = addWork("failed detail demo");
		expect(run("work.ts", ["take", wid, "--as", "board-lane"]).code).toBe(0);
		const reason =
			"repro: provider returned 502; inspect the upstream response before retrying";
		expect(
			run("work.ts", ["fail", wid, "--as", "board-lane", "--note", reason])
				.code,
		).toBe(0);
		const detail = await (
			await fetch(`${BASE}/api/task?project=${q(proj)}&id=${wid}`)
		).json();
		expect(detail.task.state).toBe("FAILED");
		expect(detail.task.failure_note).toBe(reason);
		const feed = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(feed.tasks.find((row: Row) => row.id === wid)?.failure_note).toBe(
			reason,
		);
	});

	test("/api/activity: default 80, capped at 300, newest first, per-event project and filter", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		const ins = db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'activity-burst', 'NOTE', NULL, ?, NULL)",
		);
		for (let i = 0; i < 320; i++)
			ins.run(
				Date.now(),
				JSON.stringify({
					project: proj,
					note: `burst ${i}`,
					...(i === 319 ? { sha: "abc1234" } : {}),
				}),
			);
		ins.run(
			Date.now(),
			JSON.stringify({ project: "/elsewhere/.git", note: "not yours" }),
		);
		db.close();
		const def = await (await fetch(`${BASE}/api/activity`)).json();
		expect(def.ok).toBe(true);
		expect(def.events.length).toBe(80);
		const ids = def.events.map((e: Row) => e.id);
		expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids);
		expect(def.events[0].note).toBe("not yours");
		expect(def.events[0].project).toBe("/elsewhere/.git");
		const capped = await (
			await fetch(`${BASE}/api/activity?limit=5000`)
		).json();
		expect(capped.events.length).toBe(300);
		const five = await (await fetch(`${BASE}/api/activity?limit=5`)).json();
		expect(five.events.length).toBe(5);
		for (const e of five.events)
			expect(Object.keys(e).sort()).toEqual([
				"id",
				"kind",
				"note",
				"project",
				"sha",
				"source",
				"target",
				"ts",
			]);
		expect(five.events[1].sha).toBe("abc1234"); // newest of the burst carries its sha
		const foreign = await (
			await fetch(`${BASE}/api/activity?project=${q("/elsewhere/.git")}`)
		).json();
		expect(foreign.events.length).toBe(1);
		expect(foreign.events[0].note).toBe("not yours");
	});

	test("/api/decisions: default stays OPEN-only; &history=1 adds resolved rows with answer fields", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"history fork",
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "history fork");
		expect(
			(
				await post("/api/answer", {
					id: rec.id,
					to: "board-lane",
					note: "resolved",
					token: rec.answer_token,
				})
			).status,
		).toBe(200);
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"history dismiss",
			"--as",
			"board-lane",
		]);
		const rec2 = fork(await getDecisions(), "history dismiss");
		expect((await post("/api/ack", { id: rec2.id })).status).toBe(200);
		const hist = await (await fetch(`${BASE}/api/decisions?history=1`)).json();
		const ans = hist.decisions.find((d: Row) => d.question === "history fork");
		expect(ans.state).toBe("ANSWERED");
		expect(ans.answer_note).toBe("resolved");
		expect(ans.answered_ts).toBeGreaterThan(0);
		expect("ack_ts" in ans).toBe(true);
		const cancelled = hist.decisions.find(
			(d: Row) => d.question === "history dismiss",
		);
		expect(cancelled.state).toBe("CANCELLED");
		expect(cancelled.answer_note).toBeNull();
		expect(cancelled.answered_ts).toBeNull();
		const def = await (await fetch(`${BASE}/api/decisions`)).json();
		expect(def.decisions.every((d: Row) => d.state === "OPEN")).toBe(true);
		expect(
			def.decisions.find((d: Row) => d.question === "history fork"),
		).toBeUndefined();
	});

	// name kept stable for the W833 claim-check — the checklist grew six → nine
	test("/api/setup: six advisory checks, unwired in temp HOME, llm failure neither hangs nor throws", async () => {
		const t0 = Date.now();
		const r = await (await fetch(`${BASE}/api/setup`)).json();
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(r.ok).toBe(true);
		expect(r.ts).toBeGreaterThan(0);
		expect(r.checks.map((c: Row) => c.id)).toEqual([
			"db",
			"hooks-wired",
			"session-start",
			"fleet-loop",
			"activation",
			"board-unit",
			"llm",
			"hubs",
			"bind",
		]);
		for (const c of r.checks) {
			expect(Object.keys(c).sort()).toEqual([
				"detail",
				"fix",
				"id",
				"label",
				"ok",
			]);
			expect(typeof c.label).toBe("string");
			expect(typeof c.ok).toBe("boolean");
			expect(typeof c.detail).toBe("string");
			expect(c.fix === null || typeof c.fix === "string").toBe(true);
		}
		const byId = Object.fromEntries(r.checks.map((c: Row) => [c.id, c]));
		expect(byId.db.ok).toBe(true);
		expect(byId.db.fix).toBeNull();
		expect(byId["hooks-wired"].ok).toBe(false); // temp HOME wires nothing
		expect(byId["hooks-wired"].fix).toBe("./install.sh --wire");
		expect(byId["session-start"].ok).toBe(false);
		// W882: retired monitor-agent plist check → the fleet-loop heartbeat
		// unit (scratch HOME wires nothing, so still false)
		expect(byId["fleet-loop"].ok).toBe(false);
		// W852: scratch HOME — no activation receipt, no board plist
		expect(byId.activation.ok).toBe(false);
		expect(byId["board-unit"].ok).toBe(false);
		expect(byId.llm.ok).toBe(false); // dead SUSPENDERS_LLM_URL — advisory only
		expect(byId.llm.detail).toContain("127.0.0.1:1");
		// W852: no hubs.json in scratch HOME — trivially ok
		expect(byId.hubs.ok).toBe(true);
		expect(byId.hubs.detail).toBe("no hubs configured");
		expect(byId.bind.detail).toBe("127.0.0.1");
		// W852: the feed rides the stale-while-revalidate cache — a repeat
		// fetch inside the TTL is the SAME snapshot (same ts)
		const r2 = await (await fetch(`${BASE}/api/setup`)).json();
		expect(r2.ts).toBe(r.ts);
	});
});
