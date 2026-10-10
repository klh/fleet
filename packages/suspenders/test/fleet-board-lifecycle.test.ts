// fleet-board-lifecycle.test.ts — W182 work-item lifecycle controls:
// release (unclaim), reassign (release + re-dispatch), cancel (owner-override
// close) and second-opinion (read-only REVIEW lane). Each fixture owns its
// scratch HOME; the OS chooses unused ports, isolating concurrent runs.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const { HOME, REPO, env, bin, MY_PROJ, post, addWork } = await boardFixture(
	0,
	afterAll,
);

const DB = `${HOME}/.cache/claude-governor/governor.db`;

// fixture: a RUNNING session with a fresh heartbeat = sessionAlive true
function liveSession(sid: string): void {
	const db = new Database(DB);
	db.run("PRAGMA busy_timeout = 4500");
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, NULL, ?, ?, 'RUNNING')",
	).run(sid, MY_PROJ, Date.now(), Date.now());
	db.close();
}
function dropSession(sid: string): void {
	const db = new Database(DB);
	db.run("PRAGMA busy_timeout = 4500");
	db.query("DELETE FROM sessions WHERE sid = ?").run(sid);
	db.close();
}
// fixture: put a READY work item under a live-looking claim
function claim(id: string, sid: string, state = "CLAIMED"): void {
	const db = new Database(DB);
	db.run("PRAGMA busy_timeout = 4500");
	db.query(
		"UPDATE work_items SET state = ?, owner_sid = ? WHERE project = ? AND id = ?",
	).run(state, sid, MY_PROJ, id);
	db.close();
}
function itemRow(id: string): Record<string, unknown> | null {
	const db = new Database(DB, { readonly: true });
	const row = db
		.query(
			"SELECT state, owner_sid FROM work_items WHERE project = ? AND id = ?",
		)
		.get(MY_PROJ, id) as Record<string, unknown> | null;
	db.close();
	return row;
}

describe("W182 release", () => {
	test("validation: missing id 400, unknown item 404, unclaimed 409", async () => {
		expect((await post("/api/release", { project: MY_PROJ })).status).toBe(400);
		expect(
			(await post("/api/release", { project: MY_PROJ, id: "W99999" })).status,
		).toBe(404);
		const id = addWork("w182 release validation item");
		const r = await post("/api/release", { project: MY_PROJ, id });
		expect(r.status).toBe(409);
		expect(String(r.json.error)).toContain("nothing to release");
	});

	test("dead lane: CAS reclaim, item returns to READY", async () => {
		const id = addWork("w182 release dead-lane item");
		claim(id, "s-w182-dead");
		const r = await post("/api/release", { project: MY_PROJ, id });
		expect(r.status).toBe(200);
		expect(r.json).toEqual({
			ok: true,
			item: id,
			released: "s-w182-dead",
			forced: false,
			dispatched: true,
		});
		const row = itemRow(id);
		expect(row?.state).toBe("READY");
		expect(row?.owner_sid).toBeNull();
	});

	test("live lane: 409 live:true, then force signals + releases", async () => {
		const id = addWork("w182 release live-lane item");
		claim(id, "s-w182-live");
		liveSession("s-w182-live");
		const blocked = await post("/api/release", { project: MY_PROJ, id });
		expect(blocked.status).toBe(409);
		expect(blocked.json).toEqual({
			ok: false,
			live: true,
			error: expect.any(String),
		});
		const forced = await post("/api/release", {
			project: MY_PROJ,
			id,
			force: true,
		});
		expect(forced.status).toBe(200);
		expect(forced.json.forced).toBe(true);
		expect(forced.json.dispatched).toBe(false);
		// the bank-capsule signal: a NOTE aimed at the owner, stamped on the thread
		const db = new Database(DB, { readonly: true });
		const note = db
			.query(
				"SELECT payload FROM events WHERE kind = 'NOTE' AND source = 'fleet-board' AND json_extract(payload, '$.work') = ?",
			)
			.get(id) as { payload: string } | null;
		db.close();
		expect(note && String(JSON.parse(note.payload).note)).toContain(
			"bank your capsule and exit",
		);
		expect(itemRow(id)?.state).toBe("READY");
		dropSession("s-w182-live");
	});
});

describe("W182 reassign", () => {
	test("validation: unknown item 404, READY item 409", async () => {
		expect(
			(
				await post("/api/reassign", {
					project: MY_PROJ,
					id: "W99999",
					agent: "codex",
				})
			).status,
		).toBe(404);
		const id = addWork("w182 reassign validation item");
		const r = await post("/api/reassign", {
			project: MY_PROJ,
			id,
			agent: "codex",
		});
		expect(r.status).toBe(409);
		expect(String(r.json.error)).toContain("reassign moves a live claim");
	});

	test("live lane: signalled + released, dispatched:false (no dispatch while live)", async () => {
		const id = addWork("w182 reassign live-lane item");
		claim(id, "s-w182-re", "RUNNING");
		liveSession("s-w182-re");
		const r = await post("/api/reassign", {
			project: MY_PROJ,
			id,
			agent: "codex",
		});
		expect(r.status).toBe(200);
		expect(r.json).toEqual({
			ok: true,
			item: id,
			released: "s-w182-re",
			forced: true,
			dispatched: false,
		});
		expect(itemRow(id)?.owner_sid).toBeNull();
		dropSession("s-w182-re");
	});
});

describe("W182 cancel", () => {
	test("validation: missing reason 400, unknown item 404, terminal 409", async () => {
		expect(
			(await post("/api/cancel", { project: MY_PROJ, id: "W1" })).status,
		).toBe(400);
		expect(
			(
				await post("/api/cancel", {
					project: MY_PROJ,
					id: "W99999",
					reason: "x",
				})
			).status,
		).toBe(404);
		const id = addWork("w182 cancel terminal item");
		const db = new Database(DB);
		db.query(
			"UPDATE work_items SET state = 'DONE' WHERE project = ? AND id = ?",
		).run(MY_PROJ, id);
		db.close();
		const r = await post("/api/cancel", {
			project: MY_PROJ,
			id,
			reason: "dup",
		});
		expect(r.status).toBe(409);
		expect(String(r.json.error)).toContain("already closed");
	});

	test("happy path: CLAIMED item closes CANCELLED, claim released", async () => {
		const id = addWork("w182 cancel happy item");
		claim(id, "s-w182-cancel");
		const r = await post("/api/cancel", {
			project: MY_PROJ,
			id,
			reason: "owner says stop",
		});
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ ok: true, item: id, state: "CANCELLED" });
		const row = itemRow(id);
		expect(row?.state).toBe("CANCELLED");
		expect(row?.owner_sid).toBeNull();
	});
});

describe("W182 second-opinion", () => {
	test("validation: missing executor 400, unknown executor 400, bad llm legs 409", async () => {
		expect(
			(await post("/api/second-opinion", { project: MY_PROJ, id: "W1" }))
				.status,
		).toBe(400);
		expect(
			(
				await post("/api/second-opinion", {
					project: MY_PROJ,
					id: "W1",
					executor: "mystery-agent",
				})
			).status,
		).toBe(400);
		expect(
			(
				await post("/api/second-opinion", {
					project: MY_PROJ,
					id: "W1",
					executor: "llm:local:59999",
				})
			).status,
		).toBe(409);
		expect(
			(
				await post("/api/second-opinion", {
					project: MY_PROJ,
					id: "W1",
					executor: "llm:zai:glm-4.6",
				})
			).status,
		).toBe(409);
	});

	test("start returns started:true and launches the detached runner", async () => {
		const id = addWork("w182 second-opinion start item");
		// llm:local:8906 is in the swarm catalog; nothing listens there in the
		// fixture, so the detached runner records verdict=error and exits 2 —
		// the ENDPOINT contract (started:true) is what this asserts
		const r = await post("/api/second-opinion", {
			project: MY_PROJ,
			id,
			executor: "llm:local:8906",
		});
		expect(r.status).toBe(200);
		expect(r.json).toEqual({
			ok: true,
			item: id,
			executor: "llm:local:8906",
			started: true,
		});
		// give the detached runner a beat to write the error verdict
		for (let i = 0; i < 50; i++) {
			const db = new Database(DB, { readonly: true });
			const fact = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`review.${id}.llm:local:8906`) as { value: string } | null;
			db.close();
			if (fact) {
				expect(JSON.parse(fact.value).verdict).toBe("ERROR");
				break;
			}
			await new Promise((res) => setTimeout(res, 200));
		}
	});
});

describe("W182 review-lane e2e (stub leg)", () => {
	test("stub leg lands fact + work.review event + NOTE", async () => {
		let captured = "";
		const stub = Bun.serve({
			port: 0,
			fetch: async (req) => {
				captured = await req.text();
				return Response.json({
					choices: [
						{
							message: {
								content: "looked at the claims: fine\nVERDICT: PASS - clean",
							},
						},
					],
				});
			},
		});
		const id = addWork("w182 review-lane e2e item");
		const p = Bun.spawn(
			[
				"bun",
				join(bin, "review-lane.ts"),
				"--item",
				id,
				"--project",
				MY_PROJ,
				"--executor",
				"glm-test",
				"--llm-url",
				`http://127.0.0.1:${stub.port}/v1/chat/completions`,
				"--llm-model",
				"glm-test-model",
			],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		);
		const errText = await new Response(p.stderr).text();
		await p.exited;
		stub.stop(true);
		if (p.exitCode !== 0)
			console.error("review-lane stderr:", errText.slice(0, 600));
		expect(p.exitCode).toBe(0);
		expect(captured).toContain(id); // the prompt carries the mission
		const db = new Database(DB, { readonly: true });
		const fact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`review.${id}.glm-test`) as { value: string } | null;
		const ev = db
			.query(
				"SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.work') = ?",
			)
			.get(id) as { payload: string } | null;
		const note = db
			.query(
				"SELECT payload FROM events WHERE kind = 'NOTE' AND source LIKE 'review:%' AND json_extract(payload, '$.work') = ?",
			)
			.get(id) as { payload: string } | null;
		db.close();
		expect(fact && JSON.parse(fact.value).verdict).toBe("PASS");
		expect(ev && JSON.parse(ev.payload).executor).toBe("glm-test");
		expect(ev && JSON.parse(ev.payload).verdict).toBe("PASS");
		expect(note).toBeTruthy();
	});
});
