// test/dispatch-next-resume.test.ts — W1271 1500-line split of
// dispatch-next.test.ts: the crash/resume/admission surface — crash resume
// budget, orphan CLI feed bounds, malformed recovery feed, capacity and
// poisoned-preparation admission, dispatcher-registry publication races, and
// the W512 Task-pin settings hook.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb.ts";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { captureClaimFeed } from "../scripts/lib/structured-feed.ts";
import { stubBuckle } from "./helpers/dispatch-harness.ts";
import {
	addItem,
	BIN,
	dispatch,
	dispatchA,
	dispatchWith,
	env,
	executor,
	expireLaunchHold,
	HOME,
	REPO,
	tool,
	toolA,
} from "./helpers/dispatch-next-kit.ts";

describe("crash resume budget", () => {
	test("an old missing-registry claim resumes with its original sid and capsule", () => {
		const id =
			(tool("work.ts", "add", "missing registry fixture").out.match(/W\d+/) ??
				[])[0] ?? "";
		const sid = `autow${id.slice(1)}-legacy`;
		expect(
			tool(
				"work.ts",
				"take",
				id,
				"--as",
				sid,
				"--origin",
				`${hostname()}:claude`,
			).code,
		).toBe(0);
		expect(
			tool(
				"coord.ts",
				"capsule",
				"set",
				"--as",
				sid,
				"--next=preserve this checkpoint",
			).code,
		).toBe(0);
		const row = JSON.parse(tool("work.ts", "show", id, "--json").out);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.run(
			"UPDATE work_items SET updated_at = 1 WHERE project = ? AND id = ?",
			[row.project, id],
		);
		db.close();
		const registry = join(REPO, ".fleet", "lanes.json");
		expect(
			JSON.parse(tool("work.ts", "orphaned", "--json").out).some(
				(r: { id: string }) => r.id === id,
			),
		).toBe(true);
		const result = dispatch("--dry-run", "--item", id);
		expect(result.out).toContain(`DRY dispatch ${id} → ${sid}`);
		expect(result.out).toContain("preserve this checkpoint");
		expect(existsSync(registry)).toBe(false);
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
		expect(tool("work.ts", "fail", id, "--as", sid).code).toBe(0);
	});
	test("automatic failure cannot alter another owner's claim", () => {
		const id =
			(tool("work.ts", "add", "ownership-safe failure fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		expect(tool("work.ts", "take", id, "--as", "current-owner").code).toBe(0);
		expect(tool("work.ts", "fail", id, "--as", "stale-owner").code).not.toBe(0);
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
	});
	test("single-executor crashes persist increasing attempts and stop at the configured cap", async () => {
		const fakeBin = join(HOME, "fake-bin");
		mkdirSync(fakeBin, { recursive: true });
		writeFileSync(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(fakeBin, "claude"), 0o700);
		const id =
			(tool("work.ts", "add", "bounded single-executor fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		const extra = {
			PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			SUSPENDERS_LANE_MAX_ATTEMPTS: "2",
		};
		for (const attempt of [0, 1]) {
			if (attempt > 0) expireLaunchHold(id);
			const result = dispatchWith(
				{ ...extra, SUSPENDERS_CLAUDE_BIN: join(fakeBin, "claude") },
				"--item",
				id,
				"--no-belt",
				"--allow-ungoverned",
			);
			expect(result.code).not.toBe(0);
			expect(result.out).toContain("executor exited during launch");
			expect(JSON.parse(tool("work.ts", "show", id, "--json").out).state).toBe(
				"READY",
			);
			expect(
				tool(
					"coord.ts",
					"fact",
					"get",
					`lane.${laneSid(id, projectIdentity(REPO))}.launch-attempt`,
				).out,
			).toContain(String(attempt));
		}
		expireLaunchHold(id);
		expect(dispatchWith(extra, "--item", id).out).toContain(
			"launch budget exhausted",
		);
		const suppressed = dispatchWith(extra, "--item", id);
		expect(suppressed.out).not.toContain("(pid");
		expect(suppressed.out).toContain("launch backoff");
		expect(JSON.parse(tool("work.ts", "show", id, "--json").out).state).toBe(
			"READY",
		);
	}, 60_000);

	test("exhausted dead claim is preserved on preview and failed before another launch", () => {
		const added = tool("work.ts", "add", "exhausted resume fixture");
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		const sid = `autow${id.slice(1)}`;
		expect(tool("work.ts", "take", id, "--as", sid).code).toBe(0);
		const fleet = join(REPO, ".fleet");
		mkdirSync(fleet, { recursive: true });
		writeFileSync(
			join(fleet, "lanes.json"),
			JSON.stringify([
				{
					sid,
					item: id,
					pid: 99999999,
					branch: `suspenders/${id}`,
					worktree: join(REPO, ".worktrees", id),
					launchedAt: 1,
					attempt: 2,
				},
			]),
		);
		writeFileSync(
			join(fleet, `lane-${sid}.log`),
			"API Error: 429 too many requests; Retry-After: 23\n",
		);
		const preview = dispatch("--dry-run", "--item", id);
		expect(preview.out).toContain("resume budget exhausted");
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
		const initial = dispatch("--item", id);
		expect(initial.out).toContain("rate-limit launch backoff");
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
		expireLaunchHold(id);
		const result = dispatch("--item", id);
		expect(result.out).toContain("launch exhausted; returned to READY");
		expect(result.out).not.toContain("REFUSED");
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"READY"',
		);
		// The worktree stays as continuation evidence while the claim returns to READY.
		expect(existsSync(join(REPO, ".worktrees", id))).toBe(true);
		rmSync(join(fleet, "lanes.json"));
	}, 60_000);
	test("exhausted dead claim is preserved on preview and returned to READY before another launch", () => {
		const id =
			(tool("work.ts", "add", "ready budget requeue fixture").out.match(
				/W\d+/,
			) ?? [])[0] ?? "";
		const project = projectIdentity(REPO);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.run(
			"CREATE TABLE IF NOT EXISTS lane_launch_budgets(project TEXT NOT NULL,item TEXT NOT NULL,reservations INTEGER NOT NULL,PRIMARY KEY(project,item))",
		);
		db.query("INSERT INTO lane_launch_budgets VALUES (?,?,?)").run(
			project,
			id,
			3,
		);
		db.close();
		const result = dispatch("--item", id);
		expect(result.out).toContain(`WAIT ${id} — launch budget exhausted`);
		expect(JSON.parse(tool("work.ts", "show", id, "--json").out).state).toBe(
			"READY",
		);
		const again = dispatch("--item", id);
		expect(again.out).toContain("launch backoff");
	});
});

test("actual orphan CLI feed exceeds 64 KiB without losing trailing claims", async () => {
	expect(tool("work.ts", "add", "large feed initializer").code).toBe(0);
	const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
	const insert = db.query(
		"INSERT INTO work_items(project,id,title,description,state,owner_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
	);
	try {
		for (let i = 0; i < 100; i++)
			insert.run(
				projectIdentity(REPO),
				`W${900000 + i}`,
				"large feed fixture",
				"x".repeat(2000),
				"CLAIMED",
				"manual-fixture",
				Date.now(),
				Date.now(),
			);
		const rows = await captureClaimFeed(
			[process.execPath, join(BIN, "work.ts"), "orphaned", "--json"],
			REPO,
			{ env },
		);
		expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(65536);
		expect(rows.some((row) => row.id === "W900099")).toBe(true);
	} finally {
		db.query("DELETE FROM work_items WHERE project=? AND owner_sid=?").run(
			projectIdentity(REPO),
			"manual-fixture",
		);
		db.close();
	}
}, 60_000);

test("malformed recovery feed is a visible refusal before dispatch or claims", () => {
	const prefix = join(HOME, "invalid-feed-prefix");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	for (const name of ["coord.ts", "worktree.ts"])
		symlinkSync(join(BIN, name), join(prefix, "bin", name));
	writeFileSync(
		join(prefix, "bin/work.ts"),
		`if(process.argv[2]==="orphaned")console.log("[{");else{const p=Bun.spawnSync([process.execPath,${JSON.stringify(join(BIN, "work.ts"))},...process.argv.slice(2)],{stdout:"pipe",stderr:"pipe"});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.exitCode);}
`,
	);
	const id =
		(tool("work.ts", "add", "invalid feed must not dispatch").out.match(
			/W\d+/,
		) ?? [])[0] ?? "";
	const result = dispatchWith(
		{ SUSPENDERS_PREFIX: prefix },
		"--item",
		id,
		"--dry-run",
	);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("RECOVERY REFUSED");
	expect(result.err).toContain("invalid or incomplete structured feed");
	expect(JSON.parse(tool("work.ts", "show", id, "--json").out).state).toBe(
		"READY",
	);
	expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
});

test("explicit fresh item respects uncertain occupied target capacity", async () => {
	const item = await addItem("capacity guarded explicit fixture");
	const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
	const { launchSchema } = await import("../scripts/lib/launch-fencing.ts");
	launchSchema(db as unknown as import("../hooks/lib/govdb.ts").GovernorStore);
	const project = projectIdentity(REPO);
	db.query(
		"INSERT INTO lane_launch_intents VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		project,
		"WHELD",
		"held-lane",
		"held-nonce",
		1,
		executor,
		hostname(),
		0,
		"PREPARING",
		null,
		null,
	);
	try {
		const result = await dispatchA(
			{},
			"--item",
			item,
			"--target",
			"1",
			"--no-belt",
		);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain(
			"target capacity occupied by live or uncertain launches",
		);
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", item, "--json")).out)
				.state,
		).toBe("READY");
		expect(existsSync(join(REPO, ".worktrees", item))).toBe(false);
	} finally {
		db.query(
			"DELETE FROM lane_launch_intents WHERE project=? AND item='WHELD'",
		).run(project);
		db.close();
	}
});
test("poisoned preparation consumes durable item budget before any fork", async () => {
	const item = await addItem("poison preparation fixture");
	// W720: W349 recreation heals a poisoned .worktrees/<item> (retire+create
	// succeeds, dispatch exits 0) — poison the .worktrees parent itself so
	// worktree create fails and the SKIP consumes the durable budget pre-fork.
	const blocked = join(REPO, ".worktrees");
	rmSync(blocked, { recursive: true, force: true });
	writeFileSync(blocked, "not a directory");
	try {
		const settings = { SUSPENDERS_LANE_MAX_ATTEMPTS: "1" };
		const first = await dispatchA(settings, "--item", item, "--no-belt");
		expect(first.out).toContain(`SKIP ${item} — worktree create failed`);
		expect(first.out).not.toContain("dispatched: ");
		const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
		expect(
			db
				.query(
					"SELECT reservations FROM lane_launch_budgets WHERE project=? AND item=?",
				)
				.get(projectIdentity(REPO), item),
		).toEqual({ reservations: 1 });
		expect(
			db
				.query(
					"SELECT state FROM lane_launch_intents WHERE project=? AND item=?",
				)
				.get(projectIdentity(REPO), item),
		).toEqual({ state: "FAILED" });
		db.close();
		const second = await dispatchA(settings, "--item", item, "--no-belt");
		expect(second.code).not.toBe(0);
		expect(second.out).toContain("launch budget exhausted");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", item, "--json")).out)
				.state,
		).toBe("READY");
	} finally {
		rmSync(blocked, { force: true });
	}
});

test("fast legitimate work start survives dispatcher registry publication", async () => {
	const item = await addItem("fast lifecycle start fixture"),
		sid = laneSid(item, projectIdentity(REPO));
	const exe = join(HOME, "fast-start-executor.ts"),
		stop = join(HOME, "stop-fast-start");
	writeFileSync(
		exe,
		`#!${process.execPath}\nimport {existsSync} from "node:fs";const start=Bun.spawnSync([process.execPath,${JSON.stringify(join(BIN, "work.ts"))},"start",${JSON.stringify(item)},"--as",process.env.SUSPENDERS_SID],{cwd:process.cwd(),env:process.env,stdout:"ignore",stderr:"ignore"});if(start.exitCode!==0)process.exit(7);const until=Date.now()+10000;setInterval(()=>{if(existsSync(${JSON.stringify(stop)})||Date.now()>until)process.exit(0)},20);`,
	);
	chmodSync(exe, 0o700);
	let pid: number | undefined;
	try {
		const result = await dispatchA(
			{ SUSPENDERS_CLAUDE_BIN: exe },
			"--item",
			item,
			"--no-belt",
		);
		expect(result.code).toBe(0);
		expect(result.out).toContain("dispatched ");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", item, "--json")).out)
				.state,
		).toBe("RUNNING");
		const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
		pid = (
			db
				.query("SELECT pid FROM lane_launch_intents WHERE project=? AND item=?")
				.get(projectIdentity(REPO), item) as { pid: number }
		).pid;
		db.close();
		const registry = JSON.parse(
			readFileSync(join(REPO, ".fleet/lanes.json"), "utf8"),
		) as { sid: string; pid: number }[];
		expect(registry.find((row) => row.sid === sid)?.pid).toBe(pid);
	} finally {
		writeFileSync(stop, "stop");
		if (pid) {
			const { processBirth } = await import("../scripts/lib/launch-fencing.ts");
			for (let i = 0; i < 100 && processBirth(pid) !== false; i++)
				await Bun.sleep(20);
		}
	}
}, 15000);
// ─── W512 Task-layer model pin via PreToolUse updatedInput ─────────────────
describe("W512 lane settings Task-pin hook", () => {
	test("dispatch writes the Task-pin hook into the lane --settings file", async () => {
		const stub = stubBuckle(true);
		const id = await addItem("W512 task-pin settings fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		const pidFile = join(HOME, "w512-sleeper.pid");
		const executor = join(HOME, "w512-sleeper");
		writeFileSync(
			executor,
			`#!/bin/sh\necho $$ > "${pidFile}"\nexec /bin/sleep 30\n`,
		);
		chmodSync(executor, 0o700);
		try {
			const result = await dispatchA(
				{
					SUSPENDERS_CLAUDE_BIN: executor,
					SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
					SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
				},
				"--item",
				id,
			);
			expect(result.out).toContain(`dispatched ${id}`);
			const settingsPath = join(REPO, ".fleet", `lane-settings-${sid}.json`);
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
				env: Record<string, string>;
				hooks: {
					PreToolUse: Array<{
						matcher: string;
						hooks: Array<{ type: string; command: string; timeout: number }>;
					}>;
				};
			};
			const group = settings.hooks.PreToolUse[0];
			expect(group.matcher).toBe("Task");
			expect(group.hooks[0].type).toBe("command");
			expect(group.hooks[0].timeout).toBe(10);
			expect(group.hooks[0].command).toContain(
				"bin/lane-model-pin.ts --model glm-5.3-flash",
			);
			expect(settings.env.ANTHROPIC_MODEL).toBe("opus");
			expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
			expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
		} finally {
			stub.stop();
			try {
				process.kill(Number(readFileSync(pidFile, "utf8")));
			} catch {}
			rmSync(join(REPO, ".fleet", "lanes.json"), { force: true });
			await toolA({}, "work.ts", "fail", id);
		}
	}, 60_000);
});
