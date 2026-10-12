// governance-mode e2e (strict/solo), recovery feeds, capacity fencing,

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../../hooks/lib/govdb.ts";
import { laneSid } from "../../hooks/lib/laneslug.ts";
import { captureClaimFeed } from "../../scripts/lib/structured-feed.ts";
import {
	HOME,
	REPO,
	BIN,
	env,
	testExecutor,
	tool,
	dispatchWith,
	stubBuckle,
	toolA,
	dispatchA,
	addItem,
} from "./fixtures.ts";

describe("governance mode e2e: probe-false strict (W422.17)", () => {
	test("fact absent → strict applies: REFUSED, claim reclaimed, exit non-zero", async () => {
		const id = await addItem("governance strict refusal item");
		const out = await dispatchA({ PATH: "/usr/bin:/bin" }, "--item", id);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain(`REFUSED ${id}`);
		expect(out.out).toContain("buckle front unreachable + governance:strict");
		expect(out.out).toContain("dispatch(es) REFUSED");
		expect(out.out).not.toContain("(pid");
		const show = await toolA({}, "work.ts", "show", id);
		expect(show.out).toContain("READY");
	}, 60_000);
});

describe("governance mode e2e: probe-false solo (W422.17)", () => {
	test("probe-false + solo → proceeds belt-direct with the loud note", async () => {
		expect((await toolA({}, "coord.ts", "governance", "solo")).code).toBe(0);
		const id = await addItem("governance solo belt-direct item");
		const sid = laneSid(id, projectIdentity(REPO));
		const out = await dispatchA({ PATH: "/usr/bin:/bin" }, "--item", id);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain("BELT-DIRECT DISPATCH");
		expect(out.out).toContain("governance:solo");
		expect(out.out).toContain("executor exited during launch");
		expect(out.out).not.toContain("(pid");
		const brief = readFileSync(join(REPO, ".fleet", `brief-${sid}.md`), "utf8");
		expect(brief).toContain("GOVERNANCE: BELT-DIRECT DISPATCH");
		// restore the default so the scratch db ends strict
		expect((await toolA({}, "coord.ts", "governance", "strict")).code).toBe(0);
	}, 60_000);
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
	const { launchSchema } = await import("../../scripts/lib/launch-fencing.ts");
	launchSchema(db as unknown as import("../../hooks/lib/govdb.ts").GovernorStore);
	const project = projectIdentity(REPO);
	db.query(
		"INSERT INTO lane_launch_intents VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		project,
		"WHELD",
		"held-lane",
		"held-nonce",
		1,
		testExecutor,
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
	const blocked = join(REPO, ".worktrees", item);
	mkdirSync(join(REPO, ".worktrees"), { recursive: true });
	writeFileSync(blocked, "not a directory");
	try {
		const settings = { SUSPENDERS_LANE_MAX_ATTEMPTS: "1" };
		const first = await dispatchA(settings, "--item", item, "--no-belt");
		expect(first.code).not.toBe(0);
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
			const { processBirth } = await import("../../scripts/lib/launch-fencing.ts");
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

