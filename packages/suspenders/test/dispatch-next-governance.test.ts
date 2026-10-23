// test/dispatch-next-governance.test.ts — W1238.6.4: the governance + launch-
// lifecycle half of the dispatch suite (W145). Covered: lane key lifecycle
// (W463), governance decisions (W422.17), hub attribution (W615), governance
// e2e (strict refusal + solo belt-direct), and the launch-plumbing e2e that
// shares this suite's scratch-home harness (orphan feed, capacity, poisoned
// prep, fast-start, W512 task-pin, W874 residue). Bodies moved verbatim from
// dispatch-next.test.ts (board-fixture convention) so the parent sits below
// the 1200-line stop rule alongside it.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import {
	hubAttributionDecision,
	laneKeyDecision,
	parseGovernanceMode,
	probeFrontDecision,
	residueOf,
} from "../scripts/dispatch-next.ts";
import { captureClaimFeed } from "../scripts/lib/structured-feed.ts";
import { dispatchHarness, stubBuckle } from "./helpers/dispatch-harness.ts";

const {
	HOME,
	REPO,
	BIN,
	executor,
	env,
	tool,
	dispatchWith,
	toolA,
	dispatchA,
	addItem,
} = dispatchHarness(afterAll, {
	tag: "w123864-dispatch-governance",
	beltEnv: true,
});

describe("lane key lifecycle (W463)", () => {
	test.each([false, true])(
		"worktree retire revokes legacy or project-qualified lane keys (%s)",
		async (qualified) => {
			const stub = stubBuckle();
			const id = await addItem("lane key lifecycle item");
			const sid = laneSid(id, qualified ? projectIdentity(REPO) : undefined);
			expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(
				0,
			);
			// W870: take provisions the tree; the create verb refuses a standing one
			expect((await toolA({}, "worktree.ts", "create", id)).code).not.toBe(0);
			mkdirSync(join(REPO, ".fleet"), { recursive: true });
			const metaPath = join(REPO, ".fleet", `lane-key-${sid}.json`);
			const settingsPath = join(REPO, ".fleet", `lane-settings-${sid}.json`);
			writeFileSync(
				metaPath,
				JSON.stringify({ sid, key_id: "deadbeefcafe", mintedAt: 1 }),
			);
			writeFileSync(settingsPath, "{}");
			const env = {
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			};
			const refused = await toolA(env, "worktree.ts", "retire", id);
			expect(refused.code).toBe(4);
			expect(existsSync(metaPath)).toBe(true);
			expect(stub.calls.some((c) => c.includes("/revoke"))).toBe(false);
			const revision = JSON.parse(
				(await toolA({}, "work.ts", "show", id, "--json")).out,
			).updated_at as number;
			const prepared = await toolA(
				env,
				"worktree.ts",
				"retire",
				id,
				"--expect-owner",
				sid,
				"--expect-updated-at",
				String(revision),
			);
			expect(prepared.code).toBe(0);
			expect(existsSync(metaPath)).toBe(true);
			expect(stub.calls.some((c) => c.includes("/revoke"))).toBe(false);
			expect(
				(await toolA({}, "work.ts", "release", id, "--as", sid)).code,
			).toBe(0);
			const out = await toolA(
				{
					SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
					SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
				},
				"worktree.ts",
				"retire",
				id,
			);
			expect(out.code).toBe(0);
			expect(out.out).toContain("deadbeefcafe");
			expect(
				stub.calls.some((c) =>
					c.includes("/v1/admin/keys/deadbeefcafe/revoke"),
				),
			).toBe(true);
			expect(existsSync(metaPath)).toBe(false);
			expect(existsSync(settingsPath)).toBe(false);
			stub.stop();
		},
		60_000,
	);
});

// ─── governance mode (W422.17, owner ruling 2026-10-06) ──────────────────
describe("governance mode decisions (W422.17)", () => {
	test("probeFrontDecision: strict refuses, citing front + governance:strict", () => {
		const d = probeFrontDecision(false, "strict");
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse")
			expect(d.why).toContain("buckle front unreachable + governance:strict");
	});

	test("probeFrontDecision: solo proceeds belt-direct with the loud note", () => {
		const d = probeFrontDecision(false, "solo");
		expect(d.mode).toBe("belt-direct");
		if (d.mode === "belt-direct") expect(d.note).toContain("governance:solo");
	});

	test("probeFrontDecision: --allow-ungoverned overrides BOTH modes", () => {
		for (const m of ["strict", "solo"] as const) {
			expect(probeFrontDecision(true, m).mode).toBe("ungoverned-override");
		}
	});

	test("parseGovernanceMode: unset/strict/garbage → strict; solo → solo", () => {
		expect(parseGovernanceMode("(unset)")).toBe("strict");
		expect(parseGovernanceMode("solo (v3)")).toBe("solo");
		expect(parseGovernanceMode("strict (v1)")).toBe("strict");
		expect(parseGovernanceMode("wibble (v9)")).toBe("strict");
	});

	test("laneKeyDecision: solo does NOT relent at mint failures (W463 stands)", () => {
		expect(laneKeyDecision(null, false, "solo").mode).toBe("refuse");
	});
});

// ─── hub-won attribution decisions (W615) ─────────────────────────────────
describe("hubAttributionDecision (W615)", () => {
	test("minted → governed: the hub's own scoped key attributes the lane", () => {
		const d = hubAttributionDecision({
			hasToken: true,
			minted: { key: "bksk_hub", keyId: "hubkey123456" },
			allowUngoverned: false,
		});
		expect(d).toEqual({
			mode: "governed",
			key: "bksk_hub",
			keyId: "hubkey123456",
		});
	});

	test("no hub credential → refuse, naming both credential surfaces", () => {
		const d = hubAttributionDecision({
			hasToken: false,
			minted: null,
			allowUngoverned: false,
		});
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") {
			expect(d.why).toContain("SUSPENDERS_HUB_<LABEL>_TOKEN");
			expect(d.why).toContain("hubs.json token");
		}
	});

	test("mint failure (credential present) → refuse (W463 stands at hubs too)", () => {
		const d = hubAttributionDecision({
			hasToken: true,
			minted: null,
			allowUngoverned: false,
		});
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") expect(d.why).toContain("mint failed");
	});

	test("--allow-ungoverned keeps the hub pin: rides the hub UNATTRIBUTED", () => {
		const d = hubAttributionDecision({
			hasToken: false,
			minted: null,
			allowUngoverned: true,
		});
		expect(d.mode).toBe("ungoverned-override");
		if (d.mode === "ungoverned-override")
			expect(d.note).toContain("rides the hub unattributed");
	});
});

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

// W874: untracked node_modules at any depth is dependency debris, never
// unbanked residue — fresh spawns that install deps must stay dispatch-ready.
describe("residueOf (W874)", () => {
	const git = (wt: string, ...args: string[]) =>
		spawnSync("/usr/bin/git", args, { cwd: wt, encoding: "utf8" });
	test("untracked node_modules (root + nested) is dispatch-ready; a dirty file still blocks", () => {
		const wt = join(REPO, "w874-residue-fixture");
		mkdirSync(join(wt, "packages", "suspenders"), { recursive: true });
		try {
			git(wt, "init", "-q");
			git(wt, "config", "user.email", "t@t.invalid");
			git(wt, "config", "user.name", "t");
			writeFileSync(join(wt, "tracked.ts"), "export const w874 = true;\n");
			// tracked so the nested install surfaces at its real depth, not
			// collapsed as "?? packages/"
			writeFileSync(
				join(wt, "packages", "suspenders", "pkg.ts"),
				"export const pkg = true;\n",
			);
			git(wt, "add", "tracked.ts", "packages/suspenders/pkg.ts");
			git(wt, "commit", "-qm", "fixture");
			expect(residueOf(wt)).toBe("");
			mkdirSync(join(wt, "node_modules"), { recursive: true });
			writeFileSync(join(wt, "node_modules", "dep.js"), "x");
			mkdirSync(join(wt, "packages", "suspenders", "node_modules"), {
				recursive: true,
			});
			writeFileSync(
				join(wt, "packages", "suspenders", "node_modules", "dep.js"),
				"x",
			);
			expect(residueOf(wt)).toBe("");
			writeFileSync(join(wt, "tracked.ts"), "export const w874 = false;\n");
			expect(residueOf(wt)).toContain("tracked.ts");
		} finally {
			rmSync(wt, { recursive: true, force: true });
		}
	});
});
