import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

// W1115: fixtures must satisfy observeDeadClaim's safety contract — a
// foreign/unknown host is intentionally HELD (never dead), so lane.dead and
// lane.stalled can only emit for a LOCAL lane whose pid the process table
// vouches for. SUSPENDERS_MAINTENANCE=0 keeps the once-cycle free of real
// maintenance children (W779 fires them into the fixture HOME otherwise);
// SUSPENDERS_PREFIX is dropped so the loop reads THIS repo's work CLI.
test.setTimeout(30_000);

const root = mkdtempSync(join(tmpdir(), "fleet-progress-test-"));
const liveProcs: Bun.Subprocess[] = [];
test.afterAll(() => {
	for (const p of liveProcs) p.kill();
	rmSync(root, { recursive: true, force: true });
});
let sequence = 0;

function fixture({ alive, host }: { alive: boolean; host: string }): {
	kinds: string[];
	reclaimed: string[];
} {
	const cwd = join(root, `repo-${++sequence}`);
	const home = join(root, `home-${sequence}`);
	const wt = join(root, `wt-${sequence}`);
	mkdirSync(cwd);
	mkdirSync(wt);
	mkdirSync(join(home, ".claude/hooks/suspenders"), { recursive: true });
	symlinkSync(
		join(import.meta.dir, "../hooks/bin"),
		join(home, ".claude/hooks/suspenders/bin"),
	);
	const env = { ...process.env, HOME: home, SUSPENDERS_MAINTENANCE: "0" };
	delete env.SUSPENDERS_PREFIX;
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
	// the lane worktree is an isolated stale dir — `work take` mints a fresh
	// .worktrees/<id> beside it, and fresh mtimes there would mask the stall
	writeFileSync(join(wt, "artifact.txt"), "frozen\n");
	const stale = new Date(Date.now() - 3_600_000);
	utimesSync(join(wt, "artifact.txt"), stale, stale);
	utimesSync(product, stale, stale);
	writeFileSync(
		join(cwd, ".fleet/lanes.json"),
		JSON.stringify([
			{
				sid,
				item: id,
				pid: alive ? livePid(sid) : 99999999,
				worktree: wt,
				branch: "test-none",
				host,
				launchedAt: Date.now() - 3_600_000,
			},
		]),
	);
	writeFileSync(
		join(cwd, `.fleet/lane-${sid}.log`),
		"DISPATCHED and thinking forever\n",
	);
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
	const reclaimed = (
		db
			.query(
				"SELECT kind FROM events WHERE kind IN ('work.released','lane.reclaimed')",
			)
			.all() as { kind: string }[]
	).map((e) => e.kind);
	db.close();
	return { kinds: events.map((e) => e.kind), reclaimed };
}

// a live harness-args process the child's ps scan can vouch for: the dir
// name carries the sid (ps args = "<dir>/claude 120") and the binary
// basename is the harness contract. The sid sits at the dir name's END:
// laneProcessIdentity's boundary regex rejects a "-" before it (live-<sid>
// fails the anchored match and the lane reads dead). Symlinked, never
// copied — a cp'd sleep fixture dies as a fake zombie (2026-10-12 event).
function livePid(sid: string): number {
	const dir = join(root, sid);
	mkdirSync(dir);
	symlinkSync("/bin/sleep", join(dir, "claude"));
	const proc = Bun.spawn([join(dir, "claude"), "120"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	liveProcs.push(proc);
	// ps visibility lags the spawn by a few hundred ms
	for (let i = 0; i < 40; i++) {
		const args = Bun.spawnSync([
			"ps",
			"-p",
			String(proc.pid),
			"-o",
			"args=",
		]).stdout.toString();
		if (args.includes(sid)) break;
		Bun.spawnSync(["/bin/sleep", "0.1"]);
	}
	return proc.pid;
}

test("dead unfinished local claims emit lane.dead", () => {
	expect(fixture({ alive: false, host: hostname() }).kinds).toContain(
		"lane.dead",
	);
});
test("local live lane with frozen worktree emits lane.stalled", () => {
	expect(fixture({ alive: true, host: hostname() }).kinds).toContain(
		"lane.stalled",
	);
});
test("remote lane is held — no dead verdict, no unsafe reclaim", () => {
	const r = fixture({ alive: false, host: "foreign-test-host" });
	expect(r.kinds).not.toContain("lane.dead");
	expect(r.kinds).not.toContain("lane.stalled");
	expect(r.reclaimed).toHaveLength(0);
});
