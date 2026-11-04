// test/board-schemas.test.ts — W1303.4 schema-first parity: the zod
// schemas (hooks/board/schemas.ts) are THE definition of the board wire
// (/api/tasks, /api/diff, /api/tail, /api/prompt/settings —
// docs/board-api.md); these tests drive a REAL board fixture and validate
// live responses against them, so payload drift fails loud here instead
// of at SPA render time.
import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
	ApiErrorSchema,
	DiffResponseSchema,
	PromptSettingsResponseSchema,
	PromptSettingsSchema,
	TailResponseSchema,
	TasksResponseSchema,
} from "../hooks/board/schemas.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const { HOME, BASE, REPO, GREPO, TOKEN, q, addWork } = await boardFixture(
	0,
	test.afterAll,
);
// addWork runs in REPO — the work item's project identity is REPO's
// realpath; GREPO is only the seeded git repo the diff test mounts.
const proj = realpathSync(REPO);

test.describe("W1303.4 board wire schemas (live responses)", () => {
	test("/api/tasks matches TasksResponseSchema", async () => {
		const w = addWork("schema parity demo");
		const all = await (await fetch(`${BASE}/api/tasks`)).json();
		expect(TasksResponseSchema.safeParse(all).success).toBeTrue();
		const feed = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(TasksResponseSchema.safeParse(feed).success).toBeTrue();
		const mine = feed.tasks.find((t: { id: string }) => t.id === w);
		expect(mine?.title).toBe("schema parity demo");
	});
	// tests appended below
	test("/api/diff matches DiffResponseSchema on a seeded lane branch", async () => {
		const g = (args: string[], cwd = GREPO) => {
			const p = Bun.spawnSync(["/usr/bin/git", ...args], {
				cwd,
				env: { ...process.env, HOME },
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
		expect(
			g(["worktree", "add", "-b", "suspenders/WSCHEMA1", join(GREPO, "wt")])
				.code,
		).toBe(0);
		await Bun.write(join(GREPO, "wt", "f.txt"), "one\ntwo\n");
		expect(g(["add", "."], join(GREPO, "wt")).code).toBe(0);
		expect(g(["commit", "-m", "lane change"], join(GREPO, "wt")).code).toBe(0);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WSCHEMA1', 'schema diff demo', 'CLAIMED', 'board-lane', 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const r = await fetch(`${BASE}/api/diff?id=WSCHEMA1`);
		expect(r.status).toBe(200);
		const j = await r.json();
		expect(DiffResponseSchema.safeParse(j).success).toBeTrue();
		expect(j.branch).toBe("suspenders/WSCHEMA1");
	});

	test("/api/diff unknown id matches ApiErrorSchema", async () => {
		const r = await fetch(`${BASE}/api/diff?id=NOPE`);
		expect(r.status).toBe(404);
		const j = await r.json();
		expect(ApiErrorSchema.safeParse(j).success).toBeTrue();
	});

	test("/api/tail matches TailResponseSchema (live lane leg)", async () => {
		// seed an owned item directly (same recipe as the diff seed) — the
		// tail route 404s before the tail shape when owner_sid is null
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WSCHEMA2', 'schema tail demo', 'CLAIMED', 'schema-lane', 'test', ?, ?)",
		).run(proj, Date.now(), Date.now());
		db.close();
		const r = await fetch(`${BASE}/api/tail?id=WSCHEMA2&project=${q(proj)}`);
		expect(r.status).toBe(200);
		const j = await r.json();
		expect(TailResponseSchema.safeParse(j).success).toBeTrue();
		expect(j.sid).toBe("schema-lane");
	});

	test("/api/prompt/settings matches the schema, GET and POST", async () => {
		const g = await (await fetch(`${BASE}/api/prompt/settings`)).json();
		expect(PromptSettingsResponseSchema.safeParse(g).success).toBeTrue();
		expect(PromptSettingsSchema.safeParse(g.settings).success).toBeTrue();
		const post = await fetch(`${BASE}/api/prompt/settings`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": TOKEN,
			},
			body: JSON.stringify({ "prompt.debug": true }),
		});
		const pj = await post.json();
		expect(PromptSettingsResponseSchema.safeParse(pj).success).toBeTrue();
		expect(pj.settings["prompt.debug"]).toBeTrue();
	});
});
