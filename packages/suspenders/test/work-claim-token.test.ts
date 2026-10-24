import { setDefaultTimeout, afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimTokenHash,
	claimTokenMint,
} from "../hooks/lib/work/work-fence.ts";

setDefaultTimeout(30_000);

const root = mkdtempSync(join(tmpdir(), "fleet-w643-"));
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
// W670: an ambient KLH_CLAIM_TOKEN (the dispatch lane running this suite)
// leaks through the process.env spread — the env channel would then satisfy
// every done() that expects a refusal, inverting the fence under test.
delete env.KLH_CLAIM_TOKEN;
const source = join(import.meta.dir, "../hooks");
afterAll(() => rmSync(root, { recursive: true, force: true }));

// a real git repo: work project identity + done's sha/commit evidence
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

const work = (args: string[], extraEnv: Record<string, string> = {}) => {
	const p = Bun.spawnSync(
		[process.execPath, join(source, "bin/work.ts"), ...args],
		{
			cwd: repo,
			env: { ...env, ...extraEnv },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
};
const cell = (sql: string, ...params: (string | number | null)[]) => {
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		return db.query(sql).get(...params);
	} finally {
		db.close();
	}
};
const run = (sql: string, ...params: (string | number | null)[]) => {
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		db.run(sql, ...params);
	} finally {
		db.close();
	}
};
const addId = (title: string, ...extra: string[]): string => {
	const r = work(["add", title, ...extra]);
	if (r.code !== 0) throw new Error(`add failed: ${r.err || r.out}`);
	return /W\d+/.exec(r.out)?.[0] ?? "";
};
const takeToken = (id: string, sid: string): string => {
	const r = work(["take", id, "--as", sid]);
	if (r.code !== 0) throw new Error(`take failed: ${r.err || r.out}`);
	const t = /claim token: ([0-9a-f]{48})/.exec(r.out)?.[1];
	if (!t) throw new Error(`take printed no token: ${r.out}`);
	return t;
};
const done = (id: string, sid: string, extra: string[] = [], e = {}) =>
	work(
		[
			"done",
			id,
			"--sha",
			sha,
			"--as",
			sid,
			"--summary",
			"integration close carrying the required verification evidence text",
			...extra,
		],
		e,
	);
const said = (r: { out: string; err: string }): string => r.err + r.out;

test("take mints and prints a one-time claim token (hash stored, raw once)", () => {
	const id = addId("fence suite token mint");
	const tok = takeToken(id, "lane-a");
	const row = cell(
		"SELECT claim_token_hash FROM work_items WHERE id = ?",
		id,
	) as { claim_token_hash: string };
	expect(row.claim_token_hash).toBe(claimTokenHash(tok));
});

test("done without a token is refused on a gated claim", () => {
	const id = addId("fence suite missing token");
	takeToken(id, "lane-b");
	const r = done(id, "lane-b");
	expect(r.code).not.toBe(0);
	expect(said(r)).toContain("claim token required");
});

test("done with the right token closes", () => {
	const id = addId("fence suite right token");
	const tok = takeToken(id, "lane-c");
	const r = done(id, "lane-c", ["--token", tok]);
	expect(r.code).toBe(0);
	const row = cell("SELECT state FROM work_items WHERE id = ?", id) as {
		state: string;
	};
	expect(row.state).toBe("DONE");
});

test("done with a wrong token is refused", () => {
	const id = addId("fence suite wrong token");
	takeToken(id, "lane-d");
	const r = done(id, "lane-d", ["--token", "f".repeat(48)]);
	expect(r.code).not.toBe(0);
	expect(said(r)).toContain("does not match the current claim");
});

test("re-take mints a NEW token and the old one is refused (stale writer)", () => {
	const id = addId("fence suite stale writer");
	const old = takeToken(id, "lane-e");
	// simulate the reclaim → READY transition (liveness-dependent in the CLI)
	run(
		"UPDATE work_items SET state = 'READY', owner_sid = NULL, claim_token_hash = NULL WHERE id = ?",
		id,
	);
	const fresh = takeToken(id, "lane-f");
	expect(fresh).not.toBe(old);
	const stale = done(id, "lane-f", ["--token", old]);
	expect(stale.code).not.toBe(0);
	expect(said(stale)).toContain("does not match the current claim");
	const ok = done(id, "lane-f", ["--token", fresh]);
	expect(ok.code).toBe(0);
});

test("env channel: KLH_CLAIM_TOKEN stands in for --token", () => {
	const id = addId("fence suite env token");
	const tok = takeToken(id, "lane-h");
	const r = done(id, "lane-h", [], { KLH_CLAIM_TOKEN: tok });
	expect(r.code).toBe(0);
});

test("legacy grace: a NULL-hash claim closes ungated", () => {
	const id = addId("fence suite legacy grace");
	takeToken(id, "lane-g");
	run("UPDATE work_items SET claim_token_hash = NULL WHERE id = ?", id);
	const r = done(id, "lane-g");
	expect(r.code).toBe(0);
});

test("mint uniqueness: two takes mint different tokens", () => {
	expect(claimTokenMint()).not.toBe(claimTokenMint());
});

test("evidence-gated done: unmatched summary refuses the transition", () => {
	const id = addId(
		"fence suite evidence gate",
		"--evidence",
		"w643-evidence-marker",
	);
	const tok = takeToken(id, "lane-i");
	const r = work([
		"done",
		id,
		"--sha",
		sha,
		"--as",
		"lane-i",
		"--summary",
		"a summary with none of the required patterns present",
		"--token",
		tok,
	]);
	expect(r.code).not.toBe(0);
	expect(said(r)).toContain("Completion evidence missing");
});

test("evidence-gated done: a matching summary closes", () => {
	const id = addId(
		"fence suite evidence pass",
		"--evidence",
		"w643-evidence-marker",
	);
	const tok = takeToken(id, "lane-j");
	const r = work([
		"done",
		id,
		"--sha",
		sha,
		"--as",
		"lane-j",
		"--summary",
		"closing with w643-evidence-marker in the summary",
		"--token",
		tok,
	]);
	expect(r.code).toBe(0);
});

test("add refuses malformed evidence declarations", () => {
	const r = work(["add", "fence suite bad evidence", "--evidence", "[oops"]);
	expect(r.code).not.toBe(0);
	expect(said(r)).toContain("evidence");
});

test("split inherits the parent's evidence declaration", () => {
	const parent = addId(
		"fence suite split parent",
		"--evidence",
		"inherit-marker",
	);
	const r = work([
		"split",
		parent,
		"fence suite split child",
		"fence suite split child two",
		"--reason",
		"independent-scopes",
		"--keep",
		"1",
	]);
	expect(r.code).toBe(0);
	const n = cell(
		"SELECT COUNT(*) AS n FROM work_items WHERE parent_id = ? AND evidence = 'inherit-marker'",
		parent,
	) as { n: number };
	expect(n.n).toBe(2);
});
