// test/fleet-loop-dispatch.test.ts — W72: codex workspace parity with
// worktree.ts — a fresh codex workspace gets the repo's gitignored build
// dirs symlinked in (same list, same best-effort semantics), so codex lanes
// skip reinstalls like git-worktree lanes do. Dispatch without the agent
// binary on PATH stops at the binary check, which leaves the fresh
// workspace observable; the resume path must not duplicate or clobber.
import { describe, expect, test, afterAll } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	realpathSync,
	readlinkSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	mkdirSync,
	chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "claude-w72-dispatch-home-"));
const REPO = realpathSync(
	mkdtempSync(join(tmpdir(), "suspenders-fleet-dispatch-repo-")),
);
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const executor = join(HOME, "codex-fixture");
writeFileSync(executor, "#!/bin/sh\nexit 0\n");
chmodSync(executor, 0o700);
const env = {
	...process.env,
	HOME,
	GOVERNOR_STORE_URL: "local",
	SUSPENDERS_CODEX_BIN: executor,
};

// dispatch invokes the INSTALLED CLI path ($HOME/.claude/hooks/suspenders/
// bin) — wire it to this repo's hooks/bin so the test exercises the repo
// under test, not whatever is installed on the machine
mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

// /usr/bin/git is PATH-independent (launchd-minimal envs), mirrors worktree.ts
const g = (args: string[], cwd = REPO): { out: string; code: number } => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString().trim(), code: p.exitCode ?? 1 };
};

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// scratch repo: a commit, a node_modules dir worth symlinking
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
mkdirSync(join(REPO, "node_modules"), { recursive: true });
writeFileSync(join(REPO, "node_modules", "m.js"), "x");
writeFileSync(join(REPO, "README.md"), "x");
writeFileSync(join(REPO, ".gitignore"), "node_modules/\n");
g(["add", "-A"]);
expect(g(["commit", "-m", "base"]).code).toBe(0);

const tool = (bin: string, ...args: string[]) => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};

const added = tool("work.ts", "add", "codex parity");
const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
expect(id).toBeTruthy();
expect(
	tool(
		"coord.ts",
		"bootstrap",
		"--as",
		`autow${id.slice(1)}`,
		"--role",
		"worker",
	).code,
).toBe(0);

// dispatch with the agent binary absent: workspace creation and the work
// claim happen first; the run stops at the Bun.which check
const dispatch = (configured = true) => {
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(BIN, "fleet-loop.ts"),
			"dispatch",
			"--repo",
			REPO,
			"--item",
			id,
			"--agent",
			"codex",
		],
		{
			cwd: REPO,
			env: {
				...env,
				SUSPENDERS_CODEX_BIN: configured ? executor : join(HOME, "missing"),
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};

describe("codex dispatch workspace parity", () => {
	test("missing configured executor refuses before a claim or workspace", () => {
		const result = dispatch(false);
		expect(result.err).toContain("codex binary not found");
		expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"READY"',
		);
	});
	test("fresh workspace symlinks build dirs; resume leaves them alone", () => {
		const d1 = dispatch();
		expect(d1.err).toContain("executor exited during launch");
		const wt = join(REPO, ".worktrees", id);
		expect(existsSync(wt)).toBe(true);
		const link = join(wt, "node_modules");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(join(REPO, "node_modules"));

		// resume (claim already ours, workspace exists): no duplicate, no clobber
		// W562: the recorded PID has been reused by this unrelated test harness.
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(REPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{
					sid: `autow${id.slice(1)}`,
					item: id,
					pid: process.pid,
					branch: `lane/${id}`,
					worktree: wt,
				},
			]),
		);
		const d2 = dispatch();
		expect(d2.err).toContain("executor exited during launch");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readdirSync(wt).filter((e) => e === "node_modules")).toHaveLength(1);
	});
});

test("direct launch survives registry loss, rejects duplicate and retains budget after reclaim", async () => {
	const newItem =
		(tool("work.ts", "add", "direct crash fence fixture").out.match(/W\d+/) ??
			[])[0] ?? "";
	expect(newItem).toBeTruthy();
	const stop = join(HOME, "stop-direct"),
		marker = join(HOME, "direct-ran"),
		exe = join(HOME, "codex-live.ts");
	writeFileSync(
		exe,
		`#!${process.execPath}\nimport {existsSync} from "node:fs";const env={...process.env};delete env.GIT_DIR;delete env.GIT_WORK_TREE;const start=Bun.spawnSync([process.execPath,${JSON.stringify(join(BIN, "work.ts"))},"start",${JSON.stringify(newItem)},"--as",process.env.SUSPENDERS_SID],{cwd:${JSON.stringify(REPO)},env,stdout:"pipe",stderr:"pipe"});if(start.exitCode!==0){console.error(start.stderr.toString());process.exit(7);}await Bun.write(${JSON.stringify(marker)},"ran");const until=Date.now()+10000;setInterval(()=>{if(existsSync(${JSON.stringify(stop)})||Date.now()>until)process.exit(0)},20);`,
	);
	chmodSync(exe, 0o700);
	const launch = () =>
		Bun.spawnSync(
			[
				process.execPath,
				join(BIN, "fleet-loop.ts"),
				"dispatch",
				"--repo",
				REPO,
				"--item",
				newItem,
				"--agent",
				"codex",
			],
			{
				env: {
					...env,
					SUSPENDERS_CODEX_BIN: exe,
					SUSPENDERS_LANE_MAX_ATTEMPTS: "1",
				},
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	const first = launch();
	if (first.exitCode !== 0) {
		const db = new (await import("bun:sqlite")).Database(
			join(HOME, ".cache/claude-governor/governor.db"),
		);
		const row = db
			.query("SELECT sid FROM lane_launch_intents WHERE item=?")
			.get(newItem) as { sid: string };
		db.close();
		throw new Error(
			first.stderr.toString() +
				(await Bun.file(join(REPO, `.fleet/lane-${row.sid}.log`)).text()),
		);
	}
	expect(first.exitCode).toBe(0);
	expect(existsSync(marker)).toBe(true);
	expect(JSON.parse(tool("work.ts", "show", newItem, "--json").out).state).toBe(
		"RUNNING",
	);
	const dbPath = join(HOME, ".cache/claude-governor/governor.db");
	const { Database } = await import("bun:sqlite");
	const db = new Database(dbPath);
	const intent = db
		.query("SELECT * FROM lane_launch_intents WHERE item=?")
		.get(newItem) as { project: string; pid: number; nonce: string };
	try {
		rmSync(join(REPO, ".fleet/lanes.json"), { force: true });
		const duplicate = launch();
		expect(duplicate.exitCode).not.toBe(0);
		expect(duplicate.stderr.toString()).toContain(
			"durable launch intent alive or uncertain",
		);
		expect(
			db
				.query("SELECT reservations FROM lane_launch_budgets WHERE item=?")
				.get(newItem),
		).toEqual({ reservations: 1 });
		writeFileSync(stop, "stop");
		const { processBirth } = await import("../scripts/lib/launch-fencing.ts");
		for (let n = 0; n < 100 && processBirth(intent.pid) !== false; n++)
			await Bun.sleep(20);
		expect(processBirth(intent.pid)).toBe(false);
		db.query(
			"UPDATE work_items SET state='READY',owner_sid=NULL,updated_at=? WHERE id=?",
		).run(Date.now(), newItem);
		const capped = launch();
		expect(capped.exitCode).not.toBe(0);
		expect(capped.stderr.toString()).toContain("item launch budget exhausted");
		expect(
			JSON.parse(tool("work.ts", "show", newItem, "--json").out).state,
		).toBe("READY");
	} finally {
		writeFileSync(stop, "stop");
		db.close();
	}
}, 15000);

test("actual supported work show uses canonical checkout and holds mismatched project", async () => {
	const { canonicalWorkClaim } = await import(
		"../scripts/lib/work-inspection.ts"
	);
	const claim = canonicalWorkClaim(
		REPO,
		id,
		join(REPO, ".git"),
		join(BIN, "work.ts"),
		{
			...env,
			GIT_DIR: join(REPO, ".worktrees", id, ".gitstore"),
			GIT_WORK_TREE: join(REPO, ".worktrees", id),
		},
	);
	expect(claim?.id).toBe(id);
	expect(claim?.project).toBe(join(REPO, ".git"));
	expect(
		canonicalWorkClaim(REPO, id, "wrong-project", join(BIN, "work.ts"), env),
	).toBeNull();
});

test("actual scoped recovery CLI releases canonical claim despite hostile ambient Git and holds wrong partition", async () => {
	const { canonicalWorkClaim, canonicalWorkReclaim } = await import(
		"../scripts/lib/work-inspection.ts"
	);
	const newItem =
		(tool("work.ts", "add", "canonical recovery producer fixture").out.match(
			/W\d+/,
		) ?? [])[0] ?? "";
	const owner = "canonical-recovery-owner";
	expect(tool("work.ts", "take", newItem, "--as", owner).code).toBe(0);
	const project = join(REPO, ".git"),
		cli = join(BIN, "work.ts");
	const hostile = {
		...env,
		GIT_DIR: join(REPO, ".worktrees", id, ".gitstore"),
		GIT_WORK_TREE: join(REPO, ".worktrees", id),
		GIT_COMMON_DIR: join(REPO, ".worktrees", id, ".gitstore"),
	};
	const claim = canonicalWorkClaim(REPO, newItem, project, cli, hostile);
	if (!claim) throw Error("canonical fixture claim missing");
	const expected = { project, id: newItem, owner, revision: claim.updated_at };
	expect(
		canonicalWorkReclaim(
			REPO,
			{ ...expected, project: "wrong-project" },
			cli,
			hostile,
		).code,
	).not.toBe(0);
	expect(canonicalWorkClaim(REPO, newItem, project, cli, hostile)?.state).toBe(
		"CLAIMED",
	);
	expect(
		canonicalWorkReclaim(
			REPO,
			{ ...expected, revision: claim.updated_at - 1 },
			cli,
			hostile,
		).code,
	).not.toBe(0);
	const { Database } = await import("bun:sqlite");
	const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
	const { attemptRecovery } = await import(
		"../hooks/lib/dead-claim-recovery.ts"
	);
	const receipts: { code: number; out: string }[] = [];
	try {
		expect(
			attemptRecovery(
				db as unknown as import("../hooks/lib/govdb.ts").GovernorStore,
				expected,
				() => true,
				() => {
					const result = canonicalWorkReclaim(REPO, expected, cli, hostile);
					receipts.push(result);
					return result;
				},
				() => canonicalWorkClaim(REPO, newItem, project, cli, hostile) ?? {},
			),
		).toBe("released");
	} finally {
		db.close();
	}
	const result = receipts[0];
	if (!result) throw Error("actual recovery producer was not invoked");
	expect(result.code).toBe(0);
	expect(JSON.parse(result.out)).toEqual({
		project,
		id: newItem,
		previousOwner: owner,
		previousUpdatedAt: claim.updated_at,
		released: true,
	});
	expect(canonicalWorkClaim(REPO, newItem, project, cli, hostile)?.state).toBe(
		"READY",
	);
});
