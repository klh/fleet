import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TAIL } from "../hooks/board-html/tail.ts";
import {
	encodeProjectDir,
	resolveTranscriptPath,
} from "../hooks/lib/transcript.ts";
import {
	type CompletionRecord,
	persistCompletion,
} from "../hooks/lib/work-completion-record.ts";
import {
	crossFixture,
	fixture,
	summary,
	workFile,
} from "./helpers/completion-fixtures.ts";

test("manual completion without summary or capsule refuses instead of writing unverified DONE", () => {
	const f = fixture();
	const context = join(f.repo, ".fleet/lane-context.json");
	const { claimToken } = JSON.parse(readFileSync(context, "utf8"));
	rmSync(context);
	const result = f.work("done", f.id, "--sha", f.sha, "--token", claimToken);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain(
		"Completion requires a 40-4000 character paragraph",
	);
	const item = JSON.parse(f.work("show", f.id, "--json").out);
	expect(item.state).toBe("CLAIMED");
	expect(item.completion).toBeNull();
});

test("advertised two-token capsule closes a manual claim with an immutable completion record", () => {
	const f = fixture();
	const context = join(f.repo, ".fleet/lane-context.json");
	const { claimToken } = JSON.parse(readFileSync(context, "utf8"));
	rmSync(context);
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../hooks/bin/coord.ts"),
			"capsule",
			"set",
			"--as",
			"completion-lane",
			"--item",
			f.id,
			"--checkpoint",
			f.sha,
			"--done",
			summary,
			"--next",
			"Independent review and merge",
		],
		{
			cwd: f.repo,
			env: { ...f.env, SUSPENDERS_KEV_URL: "http://127.0.0.1:1" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(result.exitCode).toBe(0);
	const done = f.work("done", f.id, "--sha", f.sha, "--token", claimToken);
	expect(done.code).toBe(0);
	const item = JSON.parse(f.work("show", f.id, "--json").out);
	expect(item.state).toBe("DONE");
	expect(item.completion.commit_sha).toBe(f.sha);
	expect(item.completion.summary).toBe(summary);
	expect(item.completion.completed_by).toBe("completion-lane");
	expect(JSON.parse(item.completion.capsule_json).checkpoint).toBe(f.sha);
});

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

test("completion preserves honest proposal documentation in its immutable baseline diff", () => {
	const f = fixture();
	const prose = [
		"The proposals below remain un",
		"implemented unless stated otherwise.\n",
	].join("");
	writeFileSync(join(f.repo, "how-to-review.md"), prose);
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", f.repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		return p.stdout.toString().trim();
	};
	git("add", "how-to-review.md");
	git("commit", "-m", "document future review proposals honestly");
	const done = f.work(
		"done",
		f.id,
		"--sha",
		git("rev-parse", "HEAD"),
		"--summary",
		summary,
	);
	expect(done.code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("DONE");
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

function operatorEvidenceCase(released: boolean) {
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
	let token = taken.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	if (released)
		expect(
			f.work(
				"reclaim",
				f.id,
				"--reason",
				"user",
				"--force",
				"--expect-owner",
				"replacement-lane",
			).code,
		).toBe(0);
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
		...(released ? [] : ["--token", token]),
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
	const repaired = f.work(...args, evidencePath);
	expect(repaired.code).toBe(0);
	if (released)
		token = repaired.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	const afterRepair = readFileSync(contextPath, "utf8");
	if (released) {
		expect(f.work(...args, evidencePath).code).not.toBe(0);
		expect(
			f.work(
				"take",
				f.id,
				"--as",
				"competing-owner",
				"--expect-updated-at",
				String(current.updated_at),
				"--reconcile-context",
				"--force",
				"--evidence",
				evidencePath,
			).code,
		).not.toBe(0);
		expect(readFileSync(contextPath, "utf8")).toBe(afterRepair);
	}
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
}
test("explicit operator evidence repairs an old rotated claim and rejects stale or unsafe attestations", () =>
	operatorEvidenceCase(false));
test("lost-token operator reclaim and attested READY retake mint a fresh token for normal completion", () =>
	operatorEvidenceCase(true));

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
