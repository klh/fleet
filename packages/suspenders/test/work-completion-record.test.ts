import { TAIL } from "../hooks/board-html/tail.ts";
import { createHash } from "node:crypto";
import {
	persistCompletion,
	type CompletionRecord,
} from "../hooks/lib/work-completion-record.ts";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cleanup: string[] = [];
const workFile = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "w554-completion-"));
	cleanup.push(repo);
	const home = join(repo, ".test-home");
	const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	expect(git("init").exitCode).toBe(0);
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	expect(git("commit", "--allow-empty", "-m", "baseline").exitCode).toBe(0);
	const baseline = git("rev-parse", "HEAD").stdout.toString().trim();
	const work = (...args: string[]) => {
		const p = Bun.spawnSync([process.execPath, workFile, ...args], {
			cwd: repo,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};
	const id =
		work("add", "durable completion evidence").out.match(/W\d+/)?.[0] ?? "";
	expect(work("take", id, "--as", "completion-lane").code).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(
		join(repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "completion-lane",
			item: id,
			baseline,
			launchedAt: Date.now(),
		}),
	);
	writeFileSync(join(repo, "product.ts"), "export const repaired = true;\n");
	git("add", "product.ts");
	expect(git("commit", "-m", "implement repair").exitCode).toBe(0);
	const sha = git("rev-parse", "HEAD").stdout.toString().trim();
	return { repo, home, env, id, sha, baseline, work };
}
// W601: a graph project + sibling scope repo — work commits live in the
// scope repo on suspenders/<id>, the lane context in the graph repo.
function crossFixture(opts: { scope?: boolean; marker?: boolean } = {}) {
	const parent = mkdtempSync(join(tmpdir(), "w601-cross-"));
	cleanup.push(parent);
	const repo = join(parent, "fleet");
	const scopeRepoPath = join(parent, "gaps");
	mkdirSync(repo);
	mkdirSync(scopeRepoPath);
	const env = { ...process.env, HOME: join(repo, ".test-home"), GOVERNOR_STORE_URL: "" };
	const gitIn = (dir: string, ...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		expect(p.exitCode).toBe(0);
		return p.stdout.toString().trim();
	};
	for (const dir of [repo, scopeRepoPath]) {
		gitIn(dir, "init");
		gitIn(dir, "config", "user.name", "Test");
		gitIn(dir, "config", "user.email", "test@example.invalid");
		gitIn(dir, "commit", "--allow-empty", "-m", "base");
	}
	const work = (...args: string[]) => {
		const p = Bun.spawnSync([process.execPath, workFile, ...args], {
			cwd: repo,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
	};
	const id =
		work("add", "cross-repo completion evidence", ...(opts.scope === false ? [] : ["--scope", "gaps"])).out.match(/W\d+/)?.[0] ?? "";
	expect(id).toMatch(/^W\d+$/);
	expect(work("take", id, "--as", "cross-lane").code).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(
		join(repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "cross-lane",
			item: id,
			baseline: gitIn(repo, "rev-parse", "HEAD"),
			launchedAt: Date.now(),
		}),
	);
	gitIn(scopeRepoPath, "checkout", "-b", `suspenders/${id}`);
	writeFileSync(
		join(scopeRepoPath, "driver.ts"),
		opts.marker ? ["describe", ".only(", '"x", () => {});\n'].join("") : "export const settleWait = true;\n",
	);
	gitIn(scopeRepoPath, "add", "-A");
	gitIn(scopeRepoPath, "commit", "-m", `${id}: qa driver settle wait`);
	return { repo, scopeRepoPath, env, id, scopeSha: gitIn(scopeRepoPath, "rev-parse", "HEAD"), work };
}
afterEach(() => {
	for (const dir of cleanup.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const summary =
	"Implemented the product repair, verified the regression test and preserved the public interface.";

test("completion persists a paragraph with immutable commit evidence after owner is cleared", () => {
	const f = fixture();
	const done = f.work(
		"done",
		f.id,
		"--as",
		"completion-lane",
		"--sha",
		f.sha,
		"--summary",
		summary,
	);
	expect(done.code).toBe(0);
	const result = f.work("summary", f.id, "--json");
	expect(result.code).toBe(0);
	const record = JSON.parse(result.out);
	expect(record.summary).toBe(summary);
	expect(record.commit_sha).toBe(f.sha);
	expect(record.completed_by).toBe("completion-lane");
	expect(JSON.parse(f.work("show", f.id, "--json").out).owner_sid).toBeNull();
});

test("a dispatched no-op cannot become DONE using an old valid commit", () => {
	const f = fixture();
	const done = f.work("done", f.id, "--sha", f.baseline, "--summary", summary);
	expect(done.code).not.toBe(0);
	expect(done.err).toContain("product commit evidence");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("done refuses a closing diff that adds fake-completion markers (W511)", () => {
	const f = fixture();
	const gated = ["describe", ".only(", '"smoke", () => {});\n'].join("");
	writeFileSync(join(f.repo, "gate-extra.ts"), gated);
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", f.repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		return p.stdout.toString().trim();
	};
	git("add", "-A");
	git("commit", "-m", "ship the gated extra");
	const sha = git("rev-parse", "HEAD");
	const done = f.work("done", f.id, "--sha", sha, "--summary", summary);
	expect(done.code).toBe(2);
	expect(done.err).toContain("fake-completion markers");
	expect(done.err).toContain("gate-extra.ts");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("final capsule paragraph can supply the durable summary", () => {
	const f = fixture();
	const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
	const capsule = Bun.spawnSync(
		[
			process.execPath,
			coord,
			"capsule",
			"set",
			"--as",
			"completion-lane",
			`--checkpoint=${f.sha}`,
			`--done=${summary}`,
			"--next=complete",
		],
		{ cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
	expect(capsule.exitCode).toBe(0);
	expect(f.work("done", f.id, "--sha", f.sha).code).toBe(0);
	const record = JSON.parse(f.work("summary", f.id, "--json").out);
	expect(record.summary).toBe(summary);
	expect(JSON.parse(record.capsule_json).checkpoint).toBe(f.sha);
});

test("completion evidence cannot be overwritten or removed", () => {
	const f = fixture();
	expect(f.work("done", f.id, "--sha", f.sha, "--summary", summary).code).toBe(
		0,
	);
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	expect(() =>
		db.run("UPDATE work_completion_records SET summary='overwritten'"),
	).toThrow("immutable");
	expect(() => db.run("DELETE FROM work_completion_records")).toThrow(
		"immutable",
	);
	db.close();
});

test("board card and drawer share the permanent summary after logs disappear", () => {
	const f = fixture();
	expect(f.work("done", f.id, "--sha", f.sha, "--summary", summary).code).toBe(
		0,
	);
	rmSync(join(f.repo, ".fleet"), { recursive: true, force: true });
	const dataPath = join(import.meta.dir, "..", "hooks", "board", "data.ts");
	const drawerPath = join(
		import.meta.dir,
		"..",
		"hooks",
		"board",
		"routes-drawer.ts",
	);
	const contextPath = join(
		import.meta.dir,
		"..",
		"hooks",
		"board",
		"context.ts",
	);
	const script = `import { db } from ${JSON.stringify(contextPath)}; import { taskShape } from ${JSON.stringify(dataPath)}; import { handleDrawer } from ${JSON.stringify(drawerPath)}; const w=db.query("SELECT * FROM work_items WHERE id=?").get(${JSON.stringify(f.id)}); const url=new URL("http://localhost/api/tail?id="+${JSON.stringify(f.id)}); const response=await handleDrawer(new Request(url),url); console.log(JSON.stringify({card:taskShape(w,0),drawer:await response.json()}));`;
	const result = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: f.repo,
		env: f.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	const output = JSON.parse(result.stdout.toString());
	expect(output.card.tail.text).toBe(summary);
	expect(output.drawer.transcript.text).toBe(summary);
	expect(output.drawer.completion.commit_sha).toBe(f.sha);
});

test("summary is project-scoped and invalid prose cannot complete a lane", () => {
	const f = fixture();
	expect(f.work("done", f.id, "--sha", f.sha, "--summary", "DONE").code).toBe(
		2,
	);
	expect(f.work("summary", f.id).code).toBe(2);
	expect(f.work("done", f.id, "--sha", f.sha, "--summary", summary).code).toBe(
		0,
	);
	const other = fixture();
	expect(other.id).toBe(f.id);
	expect(other.work("summary", other.id).code).toBe(2);
});

test("stale capsule evidence cannot supply a new completion summary", () => {
	const f = fixture(),
		coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
	expect(
		Bun.spawnSync(
			[
				process.execPath,
				coord,
				"capsule",
				"set",
				"--as",
				"completion-lane",
				`--checkpoint=${f.baseline}`,
				`--done=${summary}`,
			],
			{ cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe" },
		).exitCode,
	).toBe(0);
	const done = f.work("done", f.id, "--sha", f.sha);
	expect(done.code).toBe(2);
	expect(done.err).toContain("capsule checkpoint must match");
});

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
	const done = f.work("done", f.id, "--as", "cross-lane", "--sha", f.scopeSha, "--summary", summary);
	expect(done.code).toBe(0);
	const record = JSON.parse(f.work("summary", f.id, "--json").out) as CompletionRecord;
	expect(record.commit_sha).toBe(f.scopeSha);
	expect(record.baseline_sha).toBeNull();
	const evidence = JSON.parse(record.evidence_json);
	expect(evidence.scope).toBe("gaps");
	expect(realpathSync(evidence.verify_repo)).toBe(realpathSync(f.scopeRepoPath));
	expect(evidence.paths).toContain("driver.ts");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("DONE");
});

test("cross-repo completion refuses fake-completion markers in the scope diff (W601)", () => {
	const f = crossFixture({ marker: true });
	const done = f.work("done", f.id, "--as", "cross-lane", "--sha", f.scopeSha, "--summary", summary);
	expect(done.code).toBe(2);
	expect(done.err).toContain("fake-completion markers");
	expect(done.err).toContain("driver.ts");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("cross-repo completion fails closed without a scope repo or with an unknown sha", () => {
	const f = crossFixture({ scope: false });
	const done = f.work("done", f.id, "--as", "cross-lane", "--sha", f.scopeSha, "--summary", summary);
	expect(done.code).toBe(2);
	expect(done.err).toContain("declares no scope repo");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
	const g = crossFixture();
	const bad = g.work("done", g.id, "--as", "cross-lane", "--sha", "deadbeefdeadbeef", "--summary", summary);
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
