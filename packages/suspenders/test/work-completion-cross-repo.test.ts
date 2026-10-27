import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

// spawn-heavy: nested work CLI + git chains exceed bun's 5s default under
// parallel gate load.
setDefaultTimeout(30_000);
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { TAIL } from "../hooks/board-html/tail.ts";
import {
	type CompletionRecord,
	persistCompletion,
} from "../hooks/lib/work/work-completion-record.ts";

import {
	crossFixture,
	drainCleanup,
	fixture,
	summary,
} from "./helpers/work-completion-fixtures.ts";

afterEach(() => drainCleanup());

test("tail requires project disambiguation when clones share an item id", () => {
	const f = fixture();
	expect(f.work("done", f.id, "--sha", f.sha, "--summary", summary).code).toBe(
		0,
	);
	const original = JSON.parse(
		f.work("summary", f.id, "--json").out,
	) as CompletionRecord;
	const otherProject = "/another/clone/.git",
		otherSummary =
			"Completed a different project and verified its separate deployment evidence.";
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	db.query(
		"INSERT INTO work_items (project,id,title,state,created_at,updated_at) VALUES (?, ?, 'other clone', 'DONE', ?, ?)",
	).run(otherProject, f.id, Date.now(), Date.now() + 10000);
	persistCompletion(db, {
		...original,
		project: otherProject,
		summary: otherSummary,
		summary_hash: createHash("sha256").update(otherSummary).digest("hex"),
	});
	db.close();
	const drawerPath = join(
		import.meta.dir,
		"..",
		"hooks",
		"board",
		"routes-drawer.ts",
	);
	const request = (project?: string) => {
		const url = `http://localhost/api/tail?id=${f.id}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
		const script = `import { handleDrawer } from ${JSON.stringify(drawerPath)}; const url=new URL(${JSON.stringify(url)}); const response=await handleDrawer(new Request(url),url); console.log(JSON.stringify({status:response.status,body:await response.json()}));`;
		const result = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: f.repo,
			env: f.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		return JSON.parse(result.stdout.toString());
	};
	expect(request().status).toBe(409);
	expect(request(original.project).body.transcript.text).toBe(summary);
	expect(request(otherProject).body.transcript.text).toBe(otherSummary);
	expect(request("/unknown/.git").status).toBe(404);
});

test("project rekey upgrades old immutable triggers and preserves completion evidence", () => {
	const f = fixture();
	expect(f.work("done", f.id, "--sha", f.sha, "--summary", summary).code).toBe(
		0,
	);
	const original = JSON.parse(
		f.work("summary", f.id, "--json").out,
	) as CompletionRecord;
	const destination = `${original.project}-rekeyed`;
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	db.run("DROP TRIGGER work_completion_immutable_update");
	db.run(
		"CREATE TRIGGER work_completion_immutable_update BEFORE UPDATE ON work_completion_records BEGIN SELECT RAISE(ABORT, 'completion records are immutable'); END",
	);
	db.close();
	const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
	const result = Bun.spawnSync(
		[
			process.execPath,
			coord,
			"project",
			"rekey",
			original.project,
			destination,
		],
		{ cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("work_completion_records");
	const migrated = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	const record = migrated
		.query("SELECT * FROM work_completion_records WHERE project=?")
		.get(destination) as CompletionRecord;
	expect(record.summary).toBe(original.summary);
	expect(record.commit_sha).toBe(original.commit_sha);
	expect(record.evidence_json).toBe(original.evidence_json);
	expect(JSON.parse(record.evidence_json).origin_project).toBe(
		original.project,
	);
	expect(
		migrated
			.query("SELECT * FROM work_completion_records WHERE project=?")
			.get(original.project),
	).toBeNull();
	expect(() =>
		migrated.run("UPDATE work_completion_records SET summary='changed'"),
	).toThrow("immutable");
	migrated.close();
});

test("cross-repo completion verifies the sha in the item's scope repo (W601)", () => {
	const f = crossFixture();
	const done = f.work(
		"done",
		f.id,
		"--as",
		"cross-lane",
		"--sha",
		f.scopeSha,
		"--summary",
		summary,
	);
	expect(done.code).toBe(0);
	const record = JSON.parse(
		f.work("summary", f.id, "--json").out,
	) as CompletionRecord;
	expect(record.commit_sha).toBe(f.scopeSha);
	expect(record.baseline_sha).toBeNull();
	const evidence = JSON.parse(record.evidence_json);
	expect(evidence.scope).toBe("gaps");
	expect(realpathSync(evidence.verify_repo)).toBe(
		realpathSync(f.scopeRepoPath),
	);
	expect(evidence.paths).toContain("driver.ts");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("DONE");
});

test("cross-repo completion refuses fake-completion markers in the scope diff (W601)", () => {
	const f = crossFixture({ marker: true });
	const done = f.work(
		"done",
		f.id,
		"--as",
		"cross-lane",
		"--sha",
		f.scopeSha,
		"--summary",
		summary,
	);
	expect(done.code).toBe(2);
	expect(done.err).toContain("fake-completion markers");
	expect(done.err).toContain("driver.ts");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("cross-repo completion fails closed without a scope repo or with an unknown sha", () => {
	const f = crossFixture({ scope: false });
	const done = f.work(
		"done",
		f.id,
		"--as",
		"cross-lane",
		"--sha",
		f.scopeSha,
		"--summary",
		summary,
	);
	expect(done.code).toBe(2);
	expect(done.err).toContain("declares no scope repo");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
	const g = crossFixture();
	const bad = g.work(
		"done",
		g.id,
		"--as",
		"cross-lane",
		"--sha",
		"deadbeefdeadbeef",
		"--summary",
		summary,
	);
	expect(bad.code).toBe(2);
	expect(bad.err).toContain("graph repo or its scope repo");
});

test("tail requests carry project and discard stale cross-project responses", async () => {
	const task = { id: "W1", proj: "/project/a/.git", data: null };
	const pending: { url: string; resolve: (response: unknown) => void }[] = [];
	const fetch = (url: string) =>
		new Promise((resolve) => pending.push({ url, resolve }));
	const api = new Function(
		"task",
		"fetch",
		"AbortSignal",
		`${TAIL}\nrenderTaskTail=function(){}; return {fetchTail,resetTail,state:function(){return tailView;}};`,
	)(task, fetch, AbortSignal);
	api.fetchTail();
	expect(
		new URL(pending[0].url, "http://localhost").searchParams.get("project"),
	).toBe(task.proj);
	task.proj = "/project/b/.git";
	api.resetTail();
	api.fetchTail();
	pending[0].resolve({
		status: 200,
		json: async () => ({ ok: true, summary: "project A" }),
	});
	await Bun.sleep(0);
	expect(api.state().data).toBeNull();
	expect(api.state().busy).toBe(true);
	pending[1].resolve({
		status: 200,
		json: async () => ({ ok: true, summary: "project B" }),
	});
	await Bun.sleep(0);
	expect(api.state().data.summary).toBe("project B");
});

test("rekey refuses an orphaned destination completion without partially moving the graph", () => {
	const f = fixture();
	expect(f.work("done", f.id, "--sha", f.sha, "--summary", summary).code).toBe(
		0,
	);
	const original = JSON.parse(
		f.work("summary", f.id, "--json").out,
	) as CompletionRecord;
	const destination = `${original.project}-occupied`;
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	persistCompletion(db, { ...original, project: destination });
	db.close();
	const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
	const result = Bun.spawnSync(
		[
			process.execPath,
			coord,
			"project",
			"rekey",
			original.project,
			destination,
		],
		{ cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).toBe(2);
	expect(result.stderr.toString()).toContain("completion record");
	expect(JSON.parse(f.work("show", f.id, "--json").out).project).toBe(
		original.project,
	);
});
