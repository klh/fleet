import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	chmodSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAIL } from "../hooks/board-html/tail.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import { assignTask } from "../hooks/lib/work-alloc.ts";
import {
	encodeProjectDir,
	resolveTranscriptPath,
} from "../hooks/lib/transcript.ts";
import {
	type CompletionRecord,
	persistCompletion,
} from "../hooks/lib/work-completion-record.ts";

const cleanup: string[] = [];
const workFile = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
function fixture(opts: { title?: string } = {}) {
	const repo = mkdtempSync(join(tmpdir(), "w554-completion-"));
	cleanup.push(repo);
	const home = join(repo, ".test-home");
	const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
	// W670: never leak the spawning lane's claim token into fixture children —
	// the context channel, not ambient env, must carry the take-minted token
	delete env.KLH_CLAIM_TOKEN;
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
	const added = work("add", opts.title ?? "durable completion evidence");
	const id = added.out.match(/W\d+/)?.[0] ?? "";
	const takeOut = work("take", id, "--as", "completion-lane");
	expect(takeOut.code).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(
		join(repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "completion-lane",
			item: id,
			baseline,
			launchedAt: Date.now(),
			// W643: the take-minted claim token rides the durable context channel
			claimToken: /claim token: ([0-9a-f]{48})/.exec(takeOut.out)?.[1],
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
	const env = {
		...process.env,
		HOME: join(repo, ".test-home"),
		GOVERNOR_STORE_URL: "",
	};
	// W670: strip the spawning lane's claim token (see fixture() above)
	delete env.KLH_CLAIM_TOKEN;
	const gitIn = (dir: string, ...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", dir, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
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
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};
	const id =
		work(
			"add",
			"cross-repo completion evidence",
			...(opts.scope === false ? [] : ["--scope", "gaps"]),
		).out.match(/W\d+/)?.[0] ?? "";
	expect(id).toMatch(/^W\d+$/);
	const takeOut = work("take", id, "--as", "cross-lane");
	expect(takeOut.code).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(
		join(repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "cross-lane",
			item: id,
			baseline: gitIn(repo, "rev-parse", "HEAD"),
			launchedAt: Date.now(),
			// W643: the take-minted claim token rides the durable context channel
			claimToken: /claim token: ([0-9a-f]{48})/.exec(takeOut.out)?.[1],
		}),
	);
	gitIn(scopeRepoPath, "checkout", "-b", `suspenders/${id}`);
	writeFileSync(
		join(scopeRepoPath, "driver.ts"),
		opts.marker
			? ["describe", ".only(", '"x", () => {});\n'].join("")
			: "export const settleWait = true;\n",
	);
	gitIn(scopeRepoPath, "add", "-A");
	gitIn(scopeRepoPath, "commit", "-m", `${id}: qa driver settle wait`);
	return {
		repo,
		scopeRepoPath,
		env,
		id,
		scopeSha: gitIn(scopeRepoPath, "rev-parse", "HEAD"),
		work,
	};
}
afterEach(() => {
	for (const dir of cleanup.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const summary =
	"Implemented the product repair, verified the regression test and preserved the public interface.";

test("completion persists a paragraph with immutable commit evidence after owner is cleared", () => {
	const f = fixture();
	f.env.SUSPENDERS_KEV_URL = "http://127.0.0.1:1";
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
	expect(done.out).toContain("knowledge candidate queued #");
	const knowledge = new Database(
		join(f.home, ".cache/claude-governor/knowledge.db"),
	);
	const queued = knowledge
		.query("SELECT source, state, origin_sid FROM knowledge_queue")
		.get() as {
		source: string;
		state: string;
		origin_sid: string;
	};
	expect(queued).toMatchObject({
		source: `work.done ${f.id}`,
		state: "queued",
		origin_sid: "completion-lane",
	});
	knowledge.close();
});

test("prior shared-session test claim and another item's capsule cannot block this close", () => {
	const f = fixture();
	const transcriptDir = join(
		f.home,
		".claude",
		"projects",
		encodeProjectDir(realpathSync(f.repo)),
	);
	mkdirSync(transcriptDir, { recursive: true });
	writeFileSync(
		join(transcriptDir, "completion-lane.jsonl"),
		JSON.stringify({
			type: "assistant",
			timestamp: new Date(Date.now() - 60_000).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "all tests pass for an earlier item" }],
			},
		}),
	);
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?)",
	).run(
		"lane.completion-lane.capsule",
		JSON.stringify({
			item: "W999",
			done: "all tests pass for W999",
			ts: Date.now(),
		}),
		"completion-lane",
		Date.now(),
	);
	db.close();
	const done = f.work("done", f.id, "--sha", f.sha, "--summary", summary);
	expect(done.code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("DONE");
});

test("current item's unsupported transcript claim still blocks completion", () => {
	const f = fixture();
	const transcriptDir = join(
		f.home,
		".claude",
		"projects",
		encodeProjectDir(realpathSync(f.repo)),
	);
	mkdirSync(transcriptDir, { recursive: true });
	writeFileSync(
		join(transcriptDir, "completion-lane.jsonl"),
		JSON.stringify({
			type: "assistant",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "all tests pass for this item" }],
			},
		}),
	);
	expect(
		resolveTranscriptPath(
			{ session_id: "completion-lane", cwd: f.repo },
			join(f.home, ".claude", "projects"),
		),
	).toBe(join(transcriptDir, "completion-lane.jsonl"));
	const done = f.work("done", f.id, "--sha", f.sha, "--summary", summary);
	expect(done.code).toBe(2);
	expect(done.err).toContain("test-pass claim not backed by evidence");
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

test("done refuses a bench-shaped item without its ledgers (W951)", () => {
	const f = fixture({ title: "bench: A/B retrieval verdict" });
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", f.repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		return p.stdout.toString().trim();
	};
	writeFileSync(join(f.repo, "bench-run.ts"), "export const verdict = true;\n");
	git("add", "-A");
	git("commit", "-m", "bench run without ledgers");
	const refused = f.work(
		"done",
		f.id,
		"--sha",
		git("rev-parse", "HEAD"),
		"--summary",
		summary,
	);
	expect(refused.code).toBe(2);
	expect(refused.err).toContain("bench-docs (W951)");
	expect(refused.err).toContain("benchmarks.md");
	expect(refused.err).toContain("doesnt_work.md");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
	writeFileSync(
		join(f.repo, "benchmarks.md"),
		"# Benchmarks\n\n- A/B: mechanical-first retrieval wins.\n",
	);
	writeFileSync(
		join(f.repo, "doesnt_work.md"),
		"# Does not work\n\n- banked telemetry rows as primary retrieval.\n",
	);
	git("add", "-A");
	git("commit", "-m", "bench: land both ledgers");
	const ok = f.work(
		"done",
		f.id,
		"--sha",
		git("rev-parse", "HEAD"),
		"--summary",
		summary,
	);
	expect(ok.code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("DONE");
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

test("kept split child completes under the splitter's parent-bound context (W652.1)", () => {
	const f = fixture();
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", f.repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	expect(
		f.work(
			"split",
			f.id,
			"kept child work",
			"sibling scope",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		).code,
	).toBe(0);
	// W628: split rebinds the keeping lane's context transactionally — restore
	// the PRE-FIX parent binding here so this test keeps exercising the
	// W652.1 fallback the rebind was built on top of.
	writeFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "completion-lane",
			item: f.id,
			baseline: f.baseline,
			launchedAt: Date.now(),
		}),
	);
	const child = `${f.id}.1`;
	writeFileSync(join(f.repo, "product.ts"), "export const keptChild = true;\n");
	expect(git("add", "product.ts").exitCode).toBe(0);
	expect(git("commit", "-m", "kept child work").exitCode).toBe(0);
	const sha2 = git("rev-parse", "HEAD").stdout.toString().trim();
	const done = f.work(
		"done",
		child,
		"--as",
		"completion-lane",
		"--sha",
		sha2,
		"--summary",
		`${summary} kept-child variant.`,
	);
	expect(done.code).toBe(0);
	expect(done.err).toContain("warning: lane context still names");
	expect(JSON.parse(f.work("show", child, "--json").out).state).toBe("DONE");
	// parent stays SHATTERED while the READY sibling holds roll-up open
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe(
		"SHATTERED",
	);
});

test("split's transactional rebind closes the kept child without the parent binding (W628)", () => {
	const f = fixture();
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", f.repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	expect(
		f.work(
			"split",
			f.id,
			"kept child work",
			"sibling scope",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		).code,
	).toBe(0);
	// the rebind landed: context names the kept child, baseline preserved
	const rebound = JSON.parse(
		readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
	);
	expect(rebound.item).toBe(`${f.id}.1`);
	expect(rebound.baseline).toBe(f.baseline);
	writeFileSync(join(f.repo, "product.ts"), "export const keptChild = true;\n");
	expect(git("add", "product.ts").exitCode).toBe(0);
	expect(git("commit", "-m", "kept child work").exitCode).toBe(0);
	const sha2 = git("rev-parse", "HEAD").stdout.toString().trim();
	const done = f.work(
		"done",
		`${f.id}.1`,
		"--as",
		"completion-lane",
		"--sha",
		sha2,
		"--summary",
		`${summary} rebound-context variant.`,
	);
	expect(done.code).toBe(0);
	expect(done.err).not.toContain("warning: lane context still names");
	expect(JSON.parse(f.work("show", `${f.id}.1`, "--json").out).state).toBe(
		"DONE",
	);
});

test("a context bound to an unrelated item still cannot complete a split child", () => {
	const f = fixture();
	expect(
		f.work(
			"split",
			f.id,
			"kept child work",
			"sibling scope",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		).code,
	).toBe(0);
	writeFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "completion-lane",
			item: "W88888",
			baseline: f.baseline,
			launchedAt: Date.now(),
		}),
	);
	const done = f.work(
		"done",
		`${f.id}.1`,
		"--as",
		"completion-lane",
		"--sha",
		f.sha,
		"--summary",
		`${summary} kept-child negative.`,
	);
	expect(done.code).toBe(2);
	expect(done.err).toContain("does not match this item and owner");
});
test("reclaimed standing worktree completes under the new claim with its original baseline", () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const context = JSON.parse(
		readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
	);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(
		join(tree, ".fleet", "lane-context.json"),
		JSON.stringify(context),
		{ mode: 0o600 },
	);
	const merged = Bun.spawnSync(["git", "merge", "--ff-only", f.sha], {
		cwd: tree,
		env: f.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(merged.exitCode).toBe(0);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const taken = f.work("take", f.id, "--as", "replacement-lane");
	expect(taken.code).toBe(0);
	const freshToken = taken.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	expect(freshToken).not.toBe(context.claimToken);
	const beforeLoser = readFileSync(
		join(tree, ".fleet", "lane-context.json"),
		"utf8",
	);
	expect(f.work("take", f.id, "--as", "loser-lane").code).not.toBe(0);
	expect(readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8")).toBe(
		beforeLoser,
	);
	const done = Bun.spawnSync(
		[
			process.execPath,
			workFile,
			"done",
			f.id,
			"--as",
			"replacement-lane",
			"--token",
			freshToken,
			"--sha",
			f.sha,
			"--summary",
			"Implemented the actual product repair and retained its original immutable baseline after reclaim.",
		],
		{ cwd: tree, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
	expect(done.stderr.toString()).not.toContain(
		"Lane completion context does not match",
	);
	expect(done.exitCode).toBe(0);
	const shown = JSON.parse(f.work("show", f.id, "--json").out);
	expect(shown.state).toBe("DONE");
	expect(shown.completion.baseline_sha).toBe(f.baseline);
	expect(shown.completion.completed_by).toBe("replacement-lane");
});

test("retake rejects corrupt provenance without changing the READY row or context", () => {
	for (const change of [
		{ claimToken: "a".repeat(48) },
		{ baseline: "b".repeat(40) },
		{ item: "W999999" },
	]) {
		const f = fixture();
		const tree = join(f.repo, ".worktrees", f.id);
		const original = JSON.parse(
			readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
		);
		mkdirSync(join(tree, ".fleet"), { recursive: true });
		const bytes = JSON.stringify({ ...original, ...change });
		writeFileSync(join(tree, ".fleet", "lane-context.json"), bytes);
		expect(
			f.work(
				"reclaim",
				f.id,
				"--reason",
				"user",
				"--force",
				"--expect-owner",
				"completion-lane",
			).code,
		).toBe(0);
		expect(f.work("take", f.id, "--as", "replacement-lane").code).not.toBe(0);
		expect(
			readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8"),
		).toBe(bytes);
		const item = JSON.parse(f.work("show", f.id, "--json").out);
		expect(item.state).toBe("READY");
		expect(item.owner_sid).toBeNull();
	}
});

test("same-owner reconciliation requires current token and durable original receipt", () => {
	const f = fixture();
	const path = join(f.repo, ".worktrees", f.id, ".fleet", "lane-context.json");
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	mkdirSync(join(f.repo, ".worktrees", f.id, ".fleet"), { recursive: true });
	writeFileSync(path, original);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const taken = f.work("take", f.id, "--as", "replacement-lane");
	expect(taken.code).toBe(0);
	const token = taken.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	const revision = String(
		JSON.parse(f.work("show", f.id, "--json").out).updated_at,
	);
	writeFileSync(path, original);
	expect(
		f.work("take", f.id, "--as", "replacement-lane", "--token", "c".repeat(48))
			.code,
	).not.toBe(0);
	expect(
		f.work("take", f.id, "--as", "stale-owner", "--token", token).code,
	).not.toBe(0);
	expect(readFileSync(path, "utf8")).toBe(original);
	expect(
		f.work(
			"take",
			f.id,
			"--as",
			"replacement-lane",
			"--token",
			token,
			"--expect-updated-at",
			revision,
		).code,
	).toBe(0);
	const context = JSON.parse(readFileSync(path, "utf8"));
	expect(context.sid).toBe("replacement-lane");
	expect(context.claimToken).toBe(token);
	expect(context.baseline).toBe(f.baseline);
	expect(context.launchedAt).toBe(JSON.parse(original).launchedAt);
});

test("failed claim transaction restores context bytes and released ownership", () => {
	const f = fixture();
	const path = join(f.repo, ".worktrees", f.id, ".fleet", "lane-context.json");
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	mkdirSync(join(f.repo, ".worktrees", f.id, ".fleet"), { recursive: true });
	writeFileSync(path, original);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	const project = realpathSync(join(f.repo, ".git"));
	const store = {
		local: true,
		query: db.query.bind(db),
		run: db.run.bind(db),
		close: () => {},
		transaction: <T>(fn: () => T) =>
			db.transaction((): T => {
				fn();
				throw new Error("injected transaction failure after file replacement");
			}),
	} as GovernorStore;
	try {
		expect(
			assignTask(store, project, {
				id: f.id,
				sid: "replacement-lane",
				reason: "rollback test",
			}).ok,
		).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(
			db
				.query(
					"SELECT state,owner_sid FROM work_items WHERE project=? AND id=?",
				)
				.get(project, f.id),
		).toEqual({ state: "READY", owner_sid: null });
	} finally {
		db.close();
	}
});

test("explicit operator evidence repairs an old rotated claim and rejects stale or unsafe attestations", () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const contextPath = join(tree, ".fleet", "lane-context.json");
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(contextPath, original);
	expect(
		Bun.spawnSync(["git", "-C", tree, "merge", "--ff-only", f.sha], {
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode,
	).toBe(0);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const taken = f.work("take", f.id, "--as", "replacement-lane");
	expect(taken.code).toBe(0);
	const token = taken.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	const current = JSON.parse(f.work("show", f.id, "--json").out);
	writeFileSync(contextPath, original);
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	const project = realpathSync(join(f.repo, ".git"));
	const events = db
		.query(
			"SELECT id,payload FROM events WHERE kind='work.claimed' AND project=? AND work=? ORDER BY id",
		)
		.all(project, f.id) as { id: number; payload: string }[];
	for (const event of events) {
		const payload = JSON.parse(event.payload);
		delete payload.context_origin;
		delete payload.claim_token_hash;
		db.query("UPDATE events SET payload=? WHERE id=?").run(
			JSON.stringify(payload),
			event.id,
		);
	}
	db.close();
	const digest = (bytes: string) =>
		createHash("sha256").update(bytes).digest("hex");
	const stopReceipt = join(f.home, "operator-stop.json");
	const stopBytes = JSON.stringify({ stopped: true, item: f.id });
	writeFileSync(stopReceipt, stopBytes, { mode: 0o600 });
	const evidencePath = join(f.home, "operator-reconcile.json");
	const evidence = {
		project,
		item: f.id,
		tree,
		owner: "replacement-lane",
		revision: current.updated_at,
		contextHash: digest(original),
		productSha: f.sha,
		originalClaimEventId: events[0]?.id,
		stopReceipt,
		stopReceiptHash: digest(stopBytes),
		attestation:
			"reviewed-original-baseline-and-merged-product-without-original-token-receipt",
	};
	const args = [
		"take",
		f.id,
		"--as",
		"replacement-lane",
		"--token",
		token,
		"--expect-updated-at",
		String(current.updated_at),
		"--reconcile-context",
		"--force",
		"--evidence",
	];
	expect(f.work(...args, evidencePath).code).not.toBe(0);
	writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o644 });
	expect(f.work(...args, evidencePath).code).not.toBe(0);
	chmodSync(evidencePath, 0o600);
	const linked = join(f.home, "operator-link.json");
	symlinkSync(evidencePath, linked);
	expect(f.work(...args, linked).code).not.toBe(0);
	writeFileSync(
		evidencePath,
		JSON.stringify({ ...evidence, revision: current.updated_at - 1 }),
	);
	expect(f.work(...args, evidencePath).code).not.toBe(0);
	expect(readFileSync(contextPath, "utf8")).toBe(original);
	writeFileSync(evidencePath, JSON.stringify(evidence));
	expect(f.work(...args, evidencePath).code).toBe(0);
	expect(JSON.parse(readFileSync(contextPath, "utf8")).sid).toBe(
		"replacement-lane",
	);
	const completed = Bun.spawnSync(
		[
			process.execPath,
			workFile,
			"done",
			f.id,
			"--as",
			"replacement-lane",
			"--token",
			token,
			"--sha",
			f.sha,
			"--summary",
			"Reconciled the reviewed historical claim and completed its real merged product without changing the original baseline.",
		],
		{ cwd: tree, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
	expect(completed.exitCode).toBe(0);
	expect(
		JSON.parse(f.work("show", f.id, "--json").out).completion.baseline_sha,
	).toBe(f.baseline);
	const records = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	try {
		const audit = records
			.query(
				"SELECT payload FROM events WHERE kind='work.context-reconciled' AND project=? AND work=?",
			)
			.get(project, f.id) as { payload: string };
		expect(JSON.parse(audit.payload).actor).toBe("operator-reconcile");
		expect(audit.payload).not.toContain(token);
		expect(audit.payload).not.toContain(JSON.parse(original).claimToken);
	} finally {
		records.close();
	}
});

test("an unregistered surviving directory cannot transfer completion identity", () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	expect(
		Bun.spawnSync(
			["git", "-C", f.repo, "worktree", "remove", "--force", tree],
			{ stdout: "pipe", stderr: "pipe" },
		).exitCode,
	).toBe(0);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(join(tree, ".fleet", "lane-context.json"), original);
	expect(f.work("take", f.id, "--as", "replacement-lane").code).not.toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("READY");
});

test("concurrent CLI retakes leave only the winning owner in row and context", async () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(
		join(tree, ".fleet", "lane-context.json"),
		readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
	);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const contenders = ["replacement-one", "replacement-two"].map((sid) =>
		Bun.spawn([process.execPath, workFile, "take", f.id, "--as", sid], {
			cwd: f.repo,
			env: f.env,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const codes = await Promise.all(contenders.map((process) => process.exited));
	expect(codes.filter((code) => code === 0)).toHaveLength(1);
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	expect(
		JSON.parse(readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8"))
			.sid,
	).toBe(row.owner_sid);
});
