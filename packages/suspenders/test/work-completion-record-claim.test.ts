// work-completion-record-claim.test.ts — the claim-lifecycle slice of the
// completion-record suite (W1238.6.6 decompose): split/retake/reclaim
// ownership transfers and their rollback guarantees. Shares the fixtures
// via test/helpers/completion-fixtures.ts (its afterEach drain applies).
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignTask } from "../hooks/lib/work-alloc.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import { fixture, summary, workFile } from "./helpers/completion-fixtures.ts";

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
