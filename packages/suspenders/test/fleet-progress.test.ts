import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
const root = mkdtempSync(join(tmpdir(), "fleet-progress-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

function fixture(alive: boolean) {
	const cwd = join(root, `repo-${++sequence}`);
	const home = join(root, `home-${sequence}`);
	mkdirSync(cwd);
	mkdirSync(join(home, ".claude/hooks/suspenders"), { recursive: true });
	symlinkSync(
		join(import.meta.dir, "../hooks/bin"),
		join(home, ".claude/hooks/suspenders/bin"),
	);
	const env = { ...process.env, HOME: home };
	const cmd = (args: string[]) =>
		Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
	cmd(["git", "init", "-q"]);
	cmd(["git", "config", "user.name", "test"]);
	cmd(["git", "config", "user.email", "test@example.invalid"]);
	const product = join(cwd, "README.md");
	writeFileSync(product, "base\n");
	cmd(["git", "add", "README.md"]);
	cmd(["git", "commit", "-qm", "base"]);
	const work = join(import.meta.dir, "../hooks/bin/work.ts");
	const id =
		cmd([process.execPath, work, "add", "progress test"])
			.stdout.toString()
			.match(/W\d+/)?.[0] ?? "";
	const sid = `test-progress-${sequence}`;
	expect(cmd([process.execPath, work, "take", id, "--as", sid]).exitCode).toBe(
		0,
	);
	mkdirSync(join(cwd, ".fleet"));
	writeFileSync(
		join(cwd, ".fleet/lanes.json"),
		JSON.stringify([
			{
				sid,
				item: id,
				pid: 99999999,
				worktree: cwd,
				branch: "test-none",
				host: "foreign-test-host",
				launchedAt: Date.now() - 3_600_000,
			},
		]),
	);
	writeFileSync(
		join(cwd, `.fleet/lane-${sid}.log`),
		"DISPATCHED and thinking forever\n",
	);
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(product, old, old);
	if (alive) {
		mkdirSync(join(home, ".claude/projects/test"), { recursive: true });
		writeFileSync(join(home, `.claude/projects/test/${sid}.jsonl`), "{}\n");
	}
	const result = cmd([
		process.execPath,
		join(import.meta.dir, "../hooks/bin/fleet-loop.ts"),
		"once",
		"--repo",
		cwd,
		"--glob",
		"nonexistent/*",
	]);
	expect(result.exitCode).toBe(0);
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	const events = db
		.query("SELECT kind FROM events WHERE source = 'fleet-loop'")
		.all() as { kind: string }[];
	db.close();
	return events.map((e) => e.kind);
}

test("dead unfinished claims emit lane.dead", () => {
	expect(fixture(false)).toContain("lane.dead");
});
test("fresh lane logs do not hide frozen product artifacts", () => {
	expect(fixture(true)).toContain("lane.stalled");
});
