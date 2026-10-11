import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fleet-capsule-"));
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
const source = join(import.meta.dir, "../hooks");
afterAll(() => rmSync(root, { recursive: true, force: true }));

// the producer validates against the CALLER's repo — run coord from a real
// git worktree so `git cat-file` can prove (or refuse) the checkpoint
const repo = join(root, "repo");
mkdirSync(repo);
const git = (...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0 ? p.stdout.toString().trim() : p.stderr.toString();
};
git("init", "-q");
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "test");
writeFileSync(join(repo, "README.md"), "base\n");
git("add", "README.md");
git("commit", "-qm", "base");
const sha = git("rev-parse", "HEAD");

function coord(...args: string[]) {
	const p = Bun.spawnSync(
		[process.execPath, join(source, "bin/coord.ts"), ...args],
		{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
	);
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
function row(key: string) {
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		return db
			.query("SELECT value, source, ts FROM facts WHERE key = ?")
			.get(key) as { value: string; source: string; ts: number } | undefined;
	} finally {
		db.close();
	}
}

test("a capsule checkpoint must be a 40-hex sha or none", () => {
	const r = coord("capsule", "set", "--as", "lane-x", "--checkpoint=head");
	expect(r.code).not.toBe(0);
	expect(r.err).toContain("40-hex");
});

test("a capsule checkpoint must resolve to a commit in the caller's repo", () => {
	const r = coord(
		"capsule",
		"set",
		"--as",
		"lane-x",
		"--checkpoint=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	);
	expect(r.code).not.toBe(0);
	expect(r.err).toContain("not a commit");
});

test("an explicit none checkpoint banks without git evidence", () => {
	expect(
		coord(
			"capsule",
			"set",
			"--as",
			"lane-x",
			"--checkpoint=none",
			"--done=started",
		).code,
	).toBe(0);
	const cap = JSON.parse(row("lane.lane-x.capsule")?.value ?? "{}");
	expect(cap.checkpoint).toBe("none");
});

test("a real commit banks with the owner as the facts source", () => {
	expect(
		coord(
			"capsule",
			"set",
			"--as",
			"lane-y",
			"--item",
			"W999",
			`--checkpoint=${sha}`,
		).code,
	).toBe(0);
	const cap = JSON.parse(row("work.W999.capsule")?.value ?? "{}");
	expect(cap.checkpoint).toBe(sha);
	expect(row("work.W999.capsule")?.source).toBe("lane-y");
});
