import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemCapsuleKey } from "../hooks/lib/capsule-fence.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

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
	const path = join(home, ".cache/claude-governor/governor.db");
	if (!existsSync(path)) return undefined;
	const db = new Database(path);
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

test("capsule rejects empty, missing and unknown payload flags without writing", () => {
	for (const payload of [
		["--done"],
		["--done="],
		["--done", ""],
		["--done", "--next", "later"],
		["--typo", "lost"],
		["--typo=lost"],
	]) {
		const result = coord(
			"capsule",
			"set",
			"--as",
			"invalid-payload",
			...payload,
		);
		expect(result.code).not.toBe(0);
		expect(row("lane.invalid-payload.capsule")).toBeUndefined();
	}
});

test("equal and two-token payloads preserve exactly the same capsule fields", () => {
	for (const equals of [true, false]) {
		const args = [
			"--checkpoint",
			sha,
			"--done",
			"Progress with = and spaces",
			"--next",
			"Continue\ncarefully",
		];
		const flags = equals
			? args
					.filter((_, index) => index % 2 === 0)
					.map((key, index) => `${key}=${args[index * 2 + 1]}`)
			: args;
		expect(
			coord("capsule", "set", "--as", "matching-payload", ...flags).code,
		).toBe(0);
		const value = JSON.parse(
			row("lane.matching-payload.capsule")?.value ?? "{}",
		);
		expect(value.checkpoint).toBe(sha);
		expect(value.done).toBe("Progress with = and spaces");
		expect(value.next).toBe("Continue\ncarefully");
	}
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
	const capKey = itemCapsuleKey(projectIdentity(repo), "W999");
	const cap = JSON.parse(row(capKey)?.value ?? "{}");
	expect(cap.checkpoint).toBe(sha);
	expect(row(capKey)?.source).toBe("lane-y");
});
