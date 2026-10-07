import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fleet-completion-"));
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
const source = join(import.meta.dir, "../hooks");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

function command(cwd: string, args: string[], input?: unknown) {
	const payload = join(root, "input.json");
	writeFileSync(payload, JSON.stringify(input ?? {}));
	const p = Bun.spawnSync(args, {
		cwd,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
function fixture() {
	const cwd = join(root, `repo-${++sequence}`);
	mkdirSync(cwd);
	const git = (...args: string[]) => command(cwd, ["git", ...args]);
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	writeFileSync(join(cwd, "README.md"), "base\n");
	git("add", "README.md");
	git("commit", "-qm", "base");
	const work = (...args: string[]) =>
		command(cwd, [process.execPath, join(source, "bin/work.ts"), ...args]);
	const id = work("add", "completion test").out.match(/W\d+/)?.[0] ?? "";
	expect(work("take", id, "--as", "dispatch-owner").code).toBe(0);
	mkdirSync(join(cwd, ".fleet"));
	writeFileSync(join(cwd, ".klh-brief.md"), "generated mission");
	writeFileSync(
		join(cwd, ".fleet/lane-context.json"),
		JSON.stringify({
			sid: "dispatch-owner",
			item: id,
			baseline: git("rev-parse", "HEAD").out.trim(),
			launchedAt: 123,
		}),
	);
	const stop = (message?: string) =>
		command(cwd, [process.execPath, join(source, "gate.ts"), "stop"], {
			cwd,
			session_id: "harness-uuid-different-from-owner",
			stop_hook_active: true,
			last_assistant_message: message,
		});
	return { cwd, git, work, id, stop };
}

test("empty lane cannot bypass stop checks; third stop records FAILED", () => {
	const f = fixture();
	for (let attempt = 1; attempt <= 2; attempt++) {
		const result = f.stop();
		expect(result.err + result.out).toContain(`Re-ask ${attempt}/2`);
	}
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("documentation edits and commits remain progress until verified work done", () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "README.md"), "meaningful change\n");
	expect(f.stop().err).toContain("STOP-GATE");
	f.git("add", "README.md");
	f.git("commit", "-qm", "delivered docs");
	expect(f.stop().err).toContain("STOP-GATE");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
	const sha = f.git("rev-parse", "HEAD").out.trim();
	expect(
		f.work(
			"done",
			f.id,
			"--sha",
			sha,
			"--summary",
			"Updated the documentation to describe the delivered behavior and verified its completion evidence.",
		).code,
	).toBe(0);
	expect(f.stop().code).toBe(0);
});

test("explicit blocked reason records incomplete work, never success", () => {
	const f = fixture();
	expect(f.stop(`BLOCKED ${f.id}: upstream service is unavailable`).code).toBe(
		0,
	);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("a different graph owner is not controlled by this lane", () => {
	const f = fixture();
	f.work("release", f.id, "--as", "dispatch-owner");
	f.work("take", f.id, "--as", "other-owner");
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).owner_sid).toBe(
		"other-owner",
	);
});

test("landed product commits do not bypass bounded failure and decision recording", () => {
	const f = fixture();
	for (let commit = 0; commit < 3; commit++) {
		writeFileSync(join(f.cwd, "feature.txt"), `implementation ${commit}\n`);
		f.git("add", "feature.txt");
		f.git("commit", "-qm", `progress ${commit}`);
	}
	expect(f.work("start", f.id, "--as", "dispatch-owner").code).toBe(0);
	for (let attempt = 1; attempt <= 2; attempt++)
		expect(f.stop().err).toContain(`Re-ask ${attempt}/2`);
	expect(f.stop().code).toBe(0);
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	expect(row.state).toBe("FAILED");
	expect(row.completion).toBeNull();
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind = 'NEED_DECISION' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.item') = ?",
				)
				.get(row.project, f.id),
		).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});

test("a dispatched DONE item without its saved paragraph cannot stop", () => {
	const f = fixture();
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		const row = JSON.parse(f.work("show", f.id, "--json").out);
		db.query(
			"UPDATE work_items SET state='DONE', owner_sid=NULL WHERE project=? AND id=?",
		).run(row.project, f.id);
	} finally {
		db.close();
	}
	expect(f.stop().err).toContain(
		"DONE without verified saved completion evidence",
	);
});

test("a legacy manual DONE without lane context remains outside the lane gate", () => {
	const f = fixture();
	rmSync(join(f.cwd, ".fleet/lane-context.json"));
	f.work("release", f.id, "--as", "dispatch-owner");
	f.work("take", f.id, "--as", "manual-owner");
	expect(
		f.work("done", f.id, "--sha", f.git("rev-parse", "HEAD").out.trim()).code,
	).toBe(0);
	expect(f.stop().code).toBe(0);
});

test("FAILED with a pending decision retries recording once before permitting stop", () => {
	const f = fixture();
	expect(
		f.work("fail", f.id, "--as", "dispatch-owner", "--note", "incomplete").code,
	).toBe(0);
	const context = JSON.parse(
		readFileSync(join(f.cwd, ".fleet/lane-context.json"), "utf8"),
	);
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	writeFileSync(
		marker,
		JSON.stringify({
			...context,
			tries: 2,
			outcome: "FAILED",
			reason: "event write was interrupted",
			decisionPending: true,
		}),
	);
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(readFileSync(marker, "utf8")).decisionPending).toBe(false);
	expect(f.stop().code).toBe(0);
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind='NEED_DECISION' AND json_extract(payload, '$.project')=? AND json_extract(payload, '$.item')=?",
				)
				.get(row.project, f.id),
		).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});
