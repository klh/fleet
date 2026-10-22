import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "fleet-start-context-"));
const repo = mkdtempSync(join(tmpdir(), "fleet-start-context-repo-"));
mkdirSync(join(repo, ".git"), { recursive: true });
const hook = join(import.meta.dir, "../hooks/session-start.ts");
const dbPath = join(home, ".cache/claude-governor/governor.db");
const env: Record<string, string | undefined> = { ...process.env, HOME: home };
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
env.SUSPENDERS_BUCKLE_FRONT = "http://127.0.0.1:1";
env.SUSPENDERS_BELT_ENV = join(home, "absent-belt.env");

// each test rides its own session_id: the notice/lesson watermarks are
// per-session (facts broadcast.seen.<sid>), so a shared sid would let one
// test's marker suppress the next test's older notice
function start(
	source: "startup" | "resume",
	sid = "historical-notice-session",
): string {
	const payload = join(home, `payload-${sid}-${source}.json`);
	writeFileSync(
		payload,
		JSON.stringify({
			session_id: sid,
			source,
			cwd: repo,
			transcript_path: join(home, "transcript.jsonl"),
		}),
	);
	const result = Bun.spawnSync(["bun", hook], {
		cwd: repo,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	return result.stdout.toString();
}

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

test("historical notice notes cap at 300 chars so one verbose broadcast cannot flood resume", () => {
	start("startup", "cap-flood-session");
	const db = new Database(dbPath);
	const long = "quota-exhausted lane reclaimed nothing ".repeat(30);
	db.query(
		"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
	).run(
		"broadcast.latest",
		JSON.stringify({ id: "cap", ts: Date.now(), note: long }),
		Date.now(),
	);
	db.close();

	const output = start("resume", "cap-flood-session");
	const notice = output
		.split("\n")
		.find((l) => l.startsWith("HISTORICAL FLEET NOTICE"));
	expect(notice).toBeDefined();
	expect(notice).toContain("…");
	expect((notice as string).length).toBeLessThan(600);
	expect(output).not.toContain(long);
});

test("resume labels old notices as history and states current Fleet coordination", () => {
	// drop the previous test's broadcast.latest: its Date.now() ts would be
	// emitted (and watermarked) by THIS test's startup run, suppressing the
	// deliberately older W931 notice below
	{
		const pre = new Database(dbPath);
		pre.query("DELETE FROM facts WHERE key = 'broadcast.latest'").run();
		pre.close();
	}
	start("startup");
	const db = new Database(dbPath);
	db.query(
		"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
	).run(
		"broadcast.latest",
		JSON.stringify({
			id: "W931",
			ts: Date.parse("2026-10-19T12:00:00Z"),
			note: "W931 review used owner clipboard to reach ChatGPT",
		}),
		Date.now(),
	);
	db.close();

	const output = start("resume");
	expect(output).toContain("CURRENT COORDINATION:");
	expect(output).toContain("coord consult");
	expect(output).toContain("coord message");
	expect(output).toContain("coord --help");
	expect(output).toContain("work --help and work <verb> --help");
	expect(output).toContain(
		"never guess a transport or read governor.db directly",
	);
	expect(output).toContain("HISTORICAL FLEET NOTICE");
	expect(output).toContain("W931 review used owner clipboard");
	expect(output).toContain("does not establish a current transport");
	expect(output).not.toContain("RULES: Work Graph");
});
