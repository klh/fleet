import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	encodeProjectDir,
	resolveTranscriptPath,
} from "../hooks/lib/transcript.ts";

import {
	drainCleanup,
	fixture,
	summary,
} from "./helpers/work-completion-fixtures.ts";

test.afterEach(() => drainCleanup());

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
	const gated = ["test.describe", ".only(", '"smoke", () => {});\n'].join("");
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
	const dataPath = join(import.meta.dir, "..", "hooks", "board", "tasks.ts");
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
