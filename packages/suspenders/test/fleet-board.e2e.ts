// fleet-board.test.ts — the fleet-board HTTP surface (W157 split; the
// factory fixture in test/helpers/board-fixture.ts gives every test
// file its own scratch HOME + board; flows live in fleet-board-flows.
import { expect, test } from "./pw";

import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { isDecisionKind } from "../hooks/lib/govdb/govdb.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

type Row = Record<string, unknown>;
const {
	TOKEN,
	HOME,
	REPO,
	GREPO,
	env,
	bin,
	PORT,
	BASE,
	run,
	q,
	sleep,
	getData,
	myProject,
	getDecisions,
	post,
	rawPost,
	fork,
	addWork,
} = await boardFixture(0, test.afterAll);

test.describe("served page", () => {
	test("inline script parses as JS (catches template corruption)", async () => {
		const r = await fetch(`${BASE}/`);
		expect(r.status).toBe(200);
		const page = await r.text();
		// only the corruption check is stable across UI rewrites — panel
		// internals belong to the UI and its own tests. Per-block, non-greedy:
		// the topbar probe script (2ae8d41) made the old greedy match span
		// both blocks + the markup between them, so it never parsed again
		const blocks = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
			(m) => m[1],
		);
		expect(blocks.length).toBeGreaterThanOrEqual(2);
		for (const b of blocks) expect(() => new Function(b)).not.toThrow();
	});

	test("GET /llms.txt — plain-text agent contract", async () => {
		const r = await fetch(`${BASE}/llms.txt`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/plain");
		const txt = await r.text();
		expect(txt).toContain("# suspenders");
		expect(txt).toContain("/api/data");
		expect(txt).toContain("/api/start");
		expect(txt).toContain("/api/fleet-tree");
		expect(txt).toContain("/fleet-tree");
		expect(txt).toContain("http://www.threads.dk");
		// companion-repo links point at the monorepo (W802; the 2026-10-05
		// cutover archived the standalone repos)
		expect(txt).not.toContain("https://github.com/klh/suspenders");
		expect(txt).not.toContain("https://github.com/klh/belt");
		expect(txt).not.toContain("https://github.com/klh/local");
		expect(txt).toContain(
			"https://github.com/klh/fleet/tree/main/packages/suspenders",
		);
		expect(txt).toContain(
			"https://github.com/klh/fleet/tree/main/packages/belt",
		);
		expect(txt).toContain(
			"https://github.com/klh/fleet/tree/main/packages/local",
		);
	});

	test("served page wires the #filter= hash deep-link (statusline worker links)", async () => {
		const r = await fetch(`${BASE}/`);
		expect(r.status).toBe(200);
		const page = await r.text();
		// hash contract: change listener + needle matcher + chip clear affordance
		expect(page).toContain("hashchange");
		expect(page).toContain("#filter=");
		expect(page).toContain("hfclear");
	});
});

test.describe("endpoint hardening", () => {
	test("unknown and non-decision event ids are rejected, not no-opped", async () => {
		expect((await post("/api/ack", { id: 999999 })).status).toBe(404);
		const unknownAns = await post("/api/answer", {
			id: 999999,
			to: "board-lane",
			note: "x",
			token: "t",
		});
		expect(unknownAns.status).toBe(404);
		expect((await post("/api/advise", { id: 999999 })).status).toBe(404);
		// a real event that is not a NEED% fork
		run("coord.ts", [
			"emit",
			"NOTE",
			"--to",
			"board-lane",
			"--note",
			"not a fork",
			"--as",
			"board-lane",
		]);
		// W810: /api/data rides the 1.5s feedMemo — poll for the fresh row
		let nonNeed: number | undefined;
		for (let i = 0; i < 20 && nonNeed === undefined; i++) {
			nonNeed = (await getData()).events.find((e: Row) => e.kind === "NOTE")
				?.id as number | undefined;
			if (nonNeed === undefined) await sleep(150);
		}
		expect(nonNeed).toBeDefined();
		expect((await post("/api/ack", { id: nonNeed })).status).toBe(400);
	});

	test("decision-kind variants (need-decision/need_decision) list AND advise — W54 regression", async () => {
		// a lane emitted need-decision; the board listed it (SQL LIKE 'NEED%'
		// is case-insensitive) then /api/advise refused it (400 "not a decision
		// event"). Both gates now share isDecisionKind().
		expect(
			run("coord.ts", [
				"emit",
				"need-decision",
				"--to",
				"board-lane",
				"--note",
				"advise the lowercase fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const lower = fork(await getDecisions(), "advise the lowercase fork");
		expect(lower).toBeDefined();
		expect((await post("/api/advise", { id: lower.id })).json.ok).toBe(true);
		expect(
			run("coord.ts", [
				"emit",
				"need_decision",
				"--to",
				"board-lane",
				"--note",
				"ack the underscore fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const under = fork(await getDecisions(), "ack the underscore fork");
		expect(under).toBeDefined();
		expect((await post("/api/ack", { id: under.id })).json.ok).toBe(true);
	});

	test("isDecisionKind accepts NEED_DECISION/need-decision/need_decision, rejects other kinds", () => {
		for (const k of [
			"NEED_DECISION",
			"need-decision",
			"need_decision",
			"NEED_INFO",
		])
			expect(isDecisionKind(k)).toBe(true);
		for (const k of [
			"NOTE",
			"work.claimed",
			"decision",
			"awaiting-input",
			"",
			"xNEED",
		])
			expect(isDecisionKind(k)).toBe(false);
	});

	test("advise accepts need-decision and refreshes pre-seeded advice (W217)", async () => {
		run("coord.ts", [
			"emit",
			"need-decision",
			"--to",
			"board-lane",
			"--note",
			"entry gate",
			"--as",
			"board-lane",
		]);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		const ev = db
			.query(
				"SELECT id FROM events WHERE kind = 'need-decision' AND json_extract(payload, '$.note') = 'entry gate'",
			)
			.get() as { id: number };
		// W217 explicitly refreshes the latest advice rather than letting a
		// stale single-slot fact suppress all future evaluations.
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
		).run(`advice.${ev.id}`, JSON.stringify({ rec: "seeded" }), Date.now());
		const mock = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					reply:
						"RECOMMENDATION: fresh advice\nRATIONALE: current evidence\nRISK: bounded",
					target: { model: "fixture", machine: "fixture" },
					ms: 1,
				}),
		});
		try {
			const child = Bun.spawn(["bun", join(bin, "advise.ts"), String(ev.id)], {
				cwd: REPO,
				env: {
					...env,
					SUSPENDERS_BELT_URL: `http://127.0.0.1:${mock.port}`,
					SUSPENDERS_LLM_MODEL: "fixture",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, out] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(out).toContain("advised");
			const fact = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${ev.id}`) as { value: string };
			expect(JSON.parse(fact.value).rec).toBe("fresh advice");
			expect(
				db
					.query(
						"SELECT COUNT(*) AS n FROM events WHERE kind = 'ADVICE' AND json_extract(payload, '$.for') = ?",
					)
					.get(ev.id),
			).toEqual({ n: 1 });
		} finally {
			mock.stop(true);
			db.close();
		}
	});

	test("answer validation: id, to, note and token are all required", async () => {
		expect(
			(await post("/api/answer", { to: "board-lane", note: "x", token: "t" }))
				.status,
		).toBe(400);
		expect(
			(await post("/api/answer", { id: 1, note: "x", token: "t" })).status,
		).toBe(400);
		expect(
			(await post("/api/answer", { id: 1, to: "board-lane", token: "t" }))
				.status,
		).toBe(400);
		expect(
			(await post("/api/answer", { id: 1, to: "board-lane", note: "x" }))
				.status,
		).toBe(400);
	});

	test("host, origin, and content-type guards", async () => {
		const evilHost = await rawPost(
			{ host: "evil.example", "content-type": "application/json" },
			'{"id":1}',
		);
		expect(evilHost.status).toBe(403);
		const evilOrigin = await rawPost(
			{
				host: `127.0.0.1:${PORT}`,
				origin: "http://evil.example:8080",
				"content-type": "application/json",
			},
			'{"id":1}',
		);
		expect(evilOrigin.status).toBe(403);
		const nullOrigin = await rawPost(
			{
				host: `127.0.0.1:${PORT}`,
				origin: "null",
				"content-type": "application/json",
			},
			'{"id":1}',
		);
		expect(nullOrigin.status).toBe(403);
		// W264: a spoofed Host never proves locality — even the wildcard bind
		// name and a valid token are refused
		const tok = {
			"x-klh-write-token": TOKEN,
			"content-type": "application/json",
		};
		for (const host of ["evil.example", "0.0.0.0", `0.0.0.0:${PORT}`]) {
			const r = await rawPost({ ...tok, host }, '{"id":1}');
			expect(r.status).toBe(403);
		}
		// DNS rebinding: Origin == Host, but the name is not allowlisted
		const rebound = await rawPost(
			{
				...tok,
				host: `rebind.example:${PORT}`,
				origin: `http://rebind.example:${PORT}`,
			},
			'{"id":1}',
		);
		expect(rebound.status).toBe(403);
		expect(rebound.body).toContain("untrusted host");
		// reads are host-gated too — a rebound page cannot read the feeds
		const readRebound = await rawPost({ host: `rebind.example:${PORT}` }, "", {
			method: "GET",
			path: "/api/data",
		});
		expect(readRebound.status).toBe(403);
		// write token: missing / wrong → 403 (never 500), on every write route
		const ct = {
			"content-type": "application/json",
			host: `127.0.0.1:${PORT}`,
		};
		for (const path of [
			"/api/ack",
			"/api/answer",
			"/api/start",
			"/console/settings/apply",
		]) {
			const none = await rawPost(ct, '{"id":1}', { path });
			expect(none.status).toBe(403);
			expect(none.body).toContain("write token required");
			const wrong = await rawPost(
				{ ...ct, "x-klh-write-token": "x".repeat(64) },
				'{"id":1}',
				{ path },
			);
			expect(wrong.status).toBe(403);
			expect(wrong.body).toContain("bad write token");
		}
		// same-origin browser with a bad cookie is refused; the allowlisted
		// Caddy name passes the host check (then fails only on the token)
		const caddy = await rawPost(
			{
				...ct,
				host: "suspenders.local",
				origin: "http://suspenders.local",
				cookie: "klh_write_token=nope",
			},
			'{"id":1}',
		);
		expect(caddy.body).toContain("bad write token");
		// the board's own pages hand out the token as an HttpOnly cookie
		const page = await fetch(`${BASE}/`);
		const cookie = page.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`klh_write_token=${TOKEN}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		const viaCookie = await rawPost(
			{ ...ct, cookie: cookie.split(";")[0] ?? "" },
			"not json",
		);
		expect(viaCookie.status).toBe(400); // past the guard → body parse
		// loopback default: the board is not listening on any LAN interface
		const lan = Object.values(networkInterfaces())
			.flat()
			.find((i) => i && i.family === "IPv4" && !i.internal)?.address;
		if (lan) {
			const reached = await fetch(`http://${lan}:${PORT}/api/data`, {
				signal: AbortSignal.timeout(2000),
			})
				.then(() => true)
				.catch(() => false);
			expect(reached).toBe(false);
		}
		const plain = await fetch(`${BASE}/api/ack`, {
			method: "POST",
			headers: { "x-klh-write-token": TOKEN, "content-type": "text/plain" },
			body: '{"id":1}',
		});
		expect(plain.status).toBe(415);
		const noCt = await fetch(`${BASE}/api/ack`, {
			method: "POST",
			headers: { "x-klh-write-token": TOKEN },
			body: '{"id":1}',
		});
		expect(noCt.status).toBe(415);
		const malformed = await post("/api/ack", undefined);
		expect(malformed.status).toBe(400);
	});
});

test.describe("dashboard accuracy", () => {
	test("advise job reconciles: error fact clears the spinner state", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"advise me",
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "advise me");
		expect(rec).toBeDefined();
		expect((await post("/api/advise", { id: rec.id })).json.ok).toBe(true);
		let err: string | undefined;
		for (let i = 0; i < 60; i++) {
			const cur = fork(await getDecisions(), "advise me");
			if (cur?.adviceError) {
				err = cur.adviceError;
				break;
			}
			await sleep(200);
		}
		expect(err).toBeDefined(); // dead SUSPENDERS_LLM_URL -> error fact -> poll picks it up
	});

	test("blocked item carries its open deps for truthful counts", async () => {
		const w1 = addWork("dep target", ["--scope", "dt"]);
		const w2 = addWork("dependent item", ["--scope", "dd"]);
		run("work.ts", ["block", w2, "--on", w1]);
		// W810: the feedMemo can serve the pre-block project view — poll
		let proj: Row | undefined;
		for (let i = 0; i < 20 && !proj; i++) {
			const p = await myProject();
			if (p?.gated?.length === 1) proj = p;
			if (!proj) await sleep(150);
		}
		expect(proj?.gated.length).toBe(1);
		expect(proj?.gated[0].deps).toEqual([w1]);
	});

	test("failed work is rendered with its error note", async () => {
		const w = addWork("doomed item", ["--scope", "df"]);
		run("work.ts", ["fail", w, "--note", "boom: no compiler"]);
		// W810: the feedMemo can serve the pre-fail project view — poll
		let failed: Row | undefined;
		for (let i = 0; i < 20 && !failed; i++) {
			failed = (await myProject()).other.find((x: Row) => x.state === "FAILED");
			if (!failed) await sleep(150);
		}
		expect(failed).toBeDefined();
		expect(failed?.note).toBe("boom: no compiler");
	});

	test("zombie chips drop the stray leading article", async () => {
		// W685: zombies render only against shown-session prefixes — bootstrap
		// the board-lane session the label references, then poll the feedMemo
		expect(run("coord.ts", ["bootstrap", "--as", "board-lane"]).code).toBe(0);
		run("coord.ts", [
			"fact",
			"set",
			"zombie.V9",
			"a board-lane ZOMBIE (hb 52min)",
		]);
		let seen = false;
		for (let i = 0; i < 20 && !seen; i++) {
			seen = (await getData()).zombies.some(
				(z: Row) => z.label === "board-lane ZOMBIE (hb 52min)",
			);
			if (!seen) await sleep(150);
		}
		expect(seen).toBe(true);
	});
});

// W28 — llm.call telemetry: advise.ts emits an llm.call event per LLM
// round-trip (usage zeros if the server omits usage; failures carry error);
// the board aggregates today's calls into per-model token sums, joined
// against optional llm.budget.<model> facts.
test.describe("W28 llm telemetry", () => {
	test("routing log + per-model budgets reach /api/data", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		const t = Date.now();
		// insert oldest-first: the routing log orders by row id (insert order),
		// not ts — backdated inserts must respect that or "newest" flips
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
		).run(
			t - 2000,
			JSON.stringify({
				for: "D3",
				model: "test-b",
				host: "127.0.0.3:9",
				pt: 0,
				ct: 0,
				tt: 0,
				ms: 50,
				error: "LLM 500",
			}),
		);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
		).run(
			t - 1000,
			JSON.stringify({
				for: "D2",
				model: "test-a",
				host: "127.0.0.2:9",
				pt: 50,
				ct: 10,
				tt: 60,
				ms: 400,
			}),
		);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
		).run(
			t,
			JSON.stringify({
				for: "D1",
				model: "test-a",
				host: "127.0.0.1:9",
				pt: 100,
				ct: 20,
				tt: 120,
				ms: 900,
			}),
		);
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES ('llm.budget.test-a', '500', 'owner', 1, ?)",
		).run(t);
		db.close();
		// W810: the direct db inserts land under the /api/data feedMemo — poll
		let d: Row | undefined;
		for (let i = 0; i < 20 && !d; i++) {
			const cur = await getData();
			if (cur.llm.usage.some((x: Row) => x.model === "test-a")) d = cur;
			if (!d) await sleep(150);
		}
		expect(d).toBeDefined();
		const u = d?.llm.usage.find((x: Row) => x.model === "test-a");
		expect(u.tokens).toBe(180); // 120 + 60 — budget-joined
		expect(u.budget).toBe(500);
		expect(u.calls).toBe(2);
		const b = d.llm.usage.find((x: Row) => x.model === "test-b");
		expect(b.tokens).toBe(0);
		expect(b.budget).toBeNull();
		expect(d.llm.calls.length).toBeGreaterThanOrEqual(3);
		const last = d.llm.calls[0]; // newest first
		expect(last.model).toBe("test-a");
		expect(last.tt).toBe(120);
		expect(d.llm.calls.some((c: Row) => c.error === "LLM 500")).toBe(true); // failures are in the log
	});
});

// W55 — per-item diff + review line-comments: GET /api/diff resolves the
// item's repo + suspenders/<id> branch (worktree.ts naming) and diffs it
// against the merge-base with main; POST /api/comment routes a review note
// to the owning lane over the coord bus.
test.describe("W55 per-item diff + review comments", () => {
	test("served page wires the diff toggle + comment flow; llms.txt lists both routes", async () => {
		const page = await (await fetch(`${BASE}/`)).text();
		expect(page).toContain("diffbtn");
		expect(page).toContain("/api/diff");
		expect(page).toContain("/api/comment");
		const txt = await (await fetch(`${BASE}/llms.txt`)).text();
		expect(txt).toContain("/api/diff");
		expect(txt).toContain("/api/comment");
	});

	test("/api/diff on an unknown id is a 404 JSON", async () => {
		const r = await fetch(`${BASE}/api/diff?id=NOPE`);
		expect(r.status).toBe(404);
		expect((await r.json()).ok).toBe(false);
	});

	test("/api/diff: stat + diff for a seeded suspenders/<id> branch", async () => {
		const g = (args: string[], cwd = GREPO) => {
			const p = Bun.spawnSync(["/usr/bin/git", ...args], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			return { out: p.stdout.toString(), code: p.exitCode };
		};
		expect(g(["init", "-b", "main"]).code).toBe(0);
		g(["config", "user.email", "t@threads.dk"]);
		g(["config", "user.name", "t"]);
		await Bun.write(join(GREPO, "f.txt"), "one\n");
		g(["add", "."]);
		expect(g(["commit", "-m", "base"]).code).toBe(0);
		// a lane worktree: branch suspenders/WDIFF1 off main, edit, commit
		expect(
			g(["worktree", "add", "-b", "suspenders/WDIFF1", join(GREPO, "wt")]).code,
		).toBe(0);
		await Bun.write(join(GREPO, "wt", "f.txt"), "one\ntwo\n");
		expect(g(["add", "."], join(GREPO, "wt")).code).toBe(0);
		expect(g(["commit", "-m", "lane change"], join(GREPO, "wt")).code).toBe(0);
		// the board resolves the item's repo from work_items.project — insert
		// the row directly (GREPO, not the empty-.git REPO fixture)
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WDIFF1', 'diff demo', 'CLAIMED', 'board-lane', 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const r = await fetch(`${BASE}/api/diff?id=WDIFF1`);
		expect(r.status).toBe(200);
		const j = await r.json();
		expect(j.ok).toBe(true);
		expect(j.branch).toBe("suspenders/WDIFF1");
		expect(j.base).toMatch(/^[0-9a-f]{40,64}$/);
		expect(j.stat).toContain("f.txt");
		expect(j.diff).toContain("+two");
	});
	test("/api/comment routes a review note to the owning lane over coord", async () => {
		const sent = await post("/api/comment", {
			id: "WDIFF1",
			file: "f.txt",
			line: "2",
			note: "why two?",
		});
		expect(sent.status).toBe(200);
		expect(sent.json.ok).toBe(true);
		expect(sent.json.to).toBe("board-lane");
		// the emit rides coord — the NOTE lands in the lane's inbox events
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		const ev = db
			.query(
				"SELECT payload FROM events WHERE kind = 'NOTE' AND target = 'board-lane' ORDER BY id DESC LIMIT 1",
			)
			.get() as { payload: string };
		db.close();
		expect(ev.payload).toContain("f.txt:2");
		expect(ev.payload).toContain("why two?");
	});
	test("/api/comment validation: missing fields 400, unknown id 404, ownerless 404, content-type 415", async () => {
		expect(
			(await post("/api/comment", { id: "WDIFF1", file: "f.txt", line: "2" }))
				.status,
		).toBe(400);
		// unknown id → 404
		expect(
			(
				await post("/api/comment", {
					id: "NOPE",
					file: "f.txt",
					line: "2",
					note: "x",
				})
			).status,
		).toBe(404);
		// ownerless item — no lane to route to
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WDIFF2', 'ownerless', 'READY', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const orphan = await post("/api/comment", {
			id: "WDIFF2",
			file: "f.txt",
			line: "1",
			note: "x",
		});
		expect(orphan.status).toBe(404);
		expect(orphan.json.error).toContain("no owning lane");
		const plain = await fetch(`${BASE}/api/comment`, {
			method: "POST",
			headers: { "x-klh-write-token": TOKEN, "content-type": "text/plain" },
			body: '{"id":"WDIFF1","file":"f.txt","line":"1","note":"x"}',
		});
		expect(plain.status).toBe(415);
	});
	test("/api/start validation: missing fields 400, unknown 404, claimed 409, not-READY 409", async () => {
		// missing fields
		expect((await post("/api/start", { project: GREPO })).status).toBe(400);
		// unknown item
		const unknown = await post("/api/start", { project: GREPO, id: "WNOPE" });
		expect(unknown.status).toBe(404);
		// claimed item (WDIFF1 — owner board-lane)
		const claimed = await post("/api/start", { project: GREPO, id: "WDIFF1" });
		expect(claimed.status).toBe(409);
		expect(claimed.json.error).toContain("already claimed");
		// non-READY item (insert a BLOCKED row — never reaches the spawn)
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WSTART1', 'blocked demo', 'BLOCKED', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const notReady = await post("/api/start", {
			project: GREPO,
			id: "WSTART1",
		});
		expect(notReady.status).toBe(409);
		expect(notReady.json.error).toContain("only READY items");
	});
	// W223.1 — copilot as a fourth lane executor: /api/start used to collapse
	// any unrecognized agent (including "copilot") down to "claude" before
	// ever reaching the binary check, so a copilot dispatch silently tried to
	// spawn claude instead. Environment-agnostic: whichever branch fires
	// (binary missing vs. binary found), it must never be claude's.
	test("/api/start no longer collapses agent:copilot into claude", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WSTART2', 'copilot dispatch probe', 'READY', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const r = await post("/api/start", {
			project: GREPO,
			id: "WSTART2",
			agent: "copilot",
		});
		const err = typeof r.json.error === "string" ? r.json.error : "";
		if (r.status === 409 && err.includes("binary not found")) {
			expect(err).toContain("copilot binary not found");
		} else {
			expect(err).not.toContain("claude binary");
		}
	});
	// W183.1 — plane-labeled executor feed: local swarm first (prime
	// position), every entry carries plane + reasoningEffort so the UI can
	// badge L/R/[HUB] and surface the effort dial. CI has no live swarm, so
	// this only asserts the feed SHAPE, never liveness.
	test("/api/executors entries carry plane + reasoningEffort", async () => {
		const r = await fetch(`${BASE}/api/executors`);
		const j = (await r.json()) as {
			ok: boolean;
			executors: { value: string; plane?: string; reasoningEffort?: boolean }[];
		};
		expect(j.ok).toBe(true);
		const planes = new Set(j.executors.map((e) => e.plane));
		for (const p of planes)
			expect(["local", "user", "hub", "remote"]).toContain(p);
		const copilot = j.executors.find((e) => e.value === "copilot");
		expect(copilot?.plane).toBe("remote");
		expect(copilot?.reasoningEffort).toBe(true);
	});
	// W183.1 — llm:local:<port> dispatch resolves against registry.ts
	// directly (no belt hop); an unknown port 404s/409s cleanly instead of
	// falling through to belt's "registry unreachable?" error.
	test("/api/start rejects an unknown llm:local:<port> target", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WSTART3', 'local swarm probe', 'READY', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const r = await post("/api/start", {
			project: GREPO,
			id: "WSTART3",
			agent: "llm:local:1",
		});
		expect(r.status).toBe(409);
		expect(r.json.error).toContain("unknown local swarm port");
	});
});

// W76 — live lane tail (lane log + transcript fallback) and message-to-lane
// (coord NOTE as the published coordinator identity, fallback fleet-board).
test.describe("W76 lane tail + message-to-lane", () => {
	test("served page wires the tail toggle + message input; llms.txt lists both routes", async () => {
		const page = await (await fetch(`${BASE}/`)).text();
		expect(page).toContain("tailbtn");
		expect(page).toContain("lanemsg");
		expect(page).toContain("/api/tail");
		expect(page).toContain("/api/message");
		const txt = await (await fetch(`${BASE}/llms.txt`)).text();
		expect(txt).toContain("/api/tail");
		expect(txt).toContain("/api/message");
	});

	test("/api/tail: lane log text + transcript fields for a claimed item", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WTAIL1', 'tail demo', 'CLAIMED', 'board-lane', 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		await Bun.write(
			join(GREPO, ".fleet", "lane-board-lane.log"),
			"booting lane...\nbuilding the thing\nDONE abc1234\n",
		);
		const r = await fetch(`${BASE}/api/tail?id=WTAIL1`);
		expect(r.status).toBe(200);
		const j = await r.json();
		expect(j.ok).toBe(true);
		expect(j.sid).toBe("board-lane");
		expect(j.log.text).toContain("building the thing");
		expect(j.log.truncated).toBe(false);
		expect(Array.isArray(j.recent)).toBe(true);
	});

	test("/api/tail validation: unknown 404, ownerless 404, bad id 404", async () => {
		expect((await fetch(`${BASE}/api/tail?id=NOPE`)).status).toBe(404);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WTAIL2', 'ownerless tail', 'READY', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const orphan = await fetch(`${BASE}/api/tail?id=WTAIL2`);
		expect(orphan.status).toBe(404);
		expect((await orphan.json()).error).toContain("no owning lane");
		expect((await fetch(`${BASE}/api/tail?id=..%2Fx`)).status).toBe(404);
	});

	test("/api/message routes to the owning lane as fleet-board when no coordinator fact", async () => {
		const sent = await post("/api/message", {
			id: "WTAIL1",
			note: "pause and wait for the owner",
		});
		expect(sent.status).toBe(200);
		expect(sent.json.ok).toBe(true);
		expect(sent.json.to).toBe("board-lane");
		expect(sent.json.as).toBe("fleet-board");
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		const ev = db
			.query(
				"SELECT source, payload FROM events WHERE kind = 'NOTE' AND target = 'board-lane' ORDER BY id DESC LIMIT 1",
			)
			.get() as { source: string; payload: string };
		db.close();
		expect(ev.source).toBe("fleet-board");
		expect(ev.payload).toContain("board WTAIL1 —");
		expect(ev.payload).toContain("pause and wait");
	});

	test("/api/message: coordinator identity when the fact is set; validation 400/404", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES ('coordinator.sid', 'coord-test', 'test', 1, ?)",
		).run(Date.now());
		db.close();
		const sent = await post("/api/message", { id: "WTAIL1", note: "second" });
		expect(sent.json.ok).toBe(true);
		expect(sent.json.as).toBe("coord-test");
		const db2 = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db2.run("PRAGMA busy_timeout = 4500");
		const ev = db2
			.query(
				"SELECT source FROM events WHERE kind = 'NOTE' AND target = 'board-lane' ORDER BY id DESC LIMIT 1",
			)
			.get() as { source: string };
		db2.close();
		expect(ev.source).toBe("coord-test");
	});
	test("/api/message validation: missing 400, unknown 404, ownerless 404, plain 415", async () => {
		expect((await post("/api/message", { id: "WTAIL1" })).status).toBe(400);
		expect((await post("/api/message", { id: "NOPE", note: "x" })).status).toBe(
			404,
		);
		expect(
			(await post("/api/message", { id: "WTAIL2", note: "x" })).status,
		).toBe(404);
		const plain = await fetch(`${BASE}/api/message`, {
			method: "POST",
			headers: { "x-klh-write-token": TOKEN, "content-type": "text/plain" },
			body: '{"id":"WTAIL1","note":"x"}',
		});
		expect(plain.status).toBe(415);
	});
});
