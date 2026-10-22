// test/dispatch-next-governance.test.ts — W1137: fail-closed governance,
// lane key lifecycle, governance mode + e2e, and the W512 Task-pin hook,
// split out of dispatch-next.test.ts (the 1500-line decomposition; pure
// moves).
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
	laneKeyDecision,
	parseGovernanceMode,
	probeFrontDecision,
} from "../scripts/dispatch-next.ts";
import { captureClaimFeed } from "../scripts/lib/structured-feed.ts";
import { dispatchHarness, stubBuckle } from "./helpers/dispatch-harness.ts";

const {
	HOME,
	REPO,
	BIN,
	executor,
	env,
	dispatchWith,
	tool,
	toolA,
	dispatchA,
	addItem,
} = dispatchHarness(afterAll, {
	tag: "w145-dispatch",
	beltEnv: true,
});

describe("fail-closed governance (W463)", () => {
	test("laneKeyDecision: mint ok → governed", () => {
		const d = laneKeyDecision({ key: "bksk_x", keyId: "abc123def45" }, false);
		expect(d.mode).toBe("governed");
		if (d.mode === "governed") {
			expect(d.key).toBe("bksk_x");
			expect(d.keyId).toBe("abc123def45");
		}
	}, 30_000);

	test("laneKeyDecision: mint fail + no flag → refuse mentioning BUCKLE_ADMIN_KEY", () => {
		const d = laneKeyDecision(null, false);
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") expect(d.why).toContain("BUCKLE_ADMIN_KEY");
	}, 30_000);

	test("laneKeyDecision: mint fail + --allow-ungoverned → loud override", () => {
		const d = laneKeyDecision(null, true);
		expect(d.mode).toBe("ungoverned-override");
		if (d.mode === "ungoverned-override")
			expect(d.note).toContain("UNGOVERNED DISPATCH");
	}, 30_000);

	test("mint failure refuses the dispatch (fail-closed), claim reclaimed, exit non-zero", async () => {
		const stub = stubBuckle();
		const id = await addItem("fail-closed governance item");
		const out = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
				// spawn-safety: even on regression, no real lane can spawn
				PATH: "/usr/bin:/bin",
			},
			"--item",
			id,
		);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain(`REFUSED ${id}`);
		expect(out.out).toContain("BUCKLE_ADMIN_KEY");
		// nothing spawned, claim reclaimed → READY
		expect(out.out).not.toContain("(pid");
		const show = await toolA({}, "work.ts", "show", id);
		expect(show.out).toContain("READY");
		stub.stop();
	}, 60_000);

	test("--allow-ungoverned discloses bypass but rejects an immediately exiting executor", async () => {
		const stub = stubBuckle();
		const id = await addItem("ungoverned override e2e item");
		const sid = laneSid(id, projectIdentity(REPO));
		const out = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
				// claude lives in ~/.local/bin — stripped PATH = executor skip
				// right after the governance block, so no real lane spawns
				PATH: "/usr/bin:/bin",
			},
			"--item",
			id,
			"--allow-ungoverned",
		);
		expect(out.code).not.toBe(0);
		expect(out.out).toContain("UNGOVERNED DISPATCH — operator override");
		expect(out.out).toContain("executor exited during launch");
		expect(out.out).not.toContain("(pid");
		const brief = readFileSync(join(REPO, ".fleet", `brief-${sid}.md`), "utf8");
		expect(brief).toContain("UNGOVERNED DISPATCH — operator override");
		const wtBrief = readFileSync(
			join(REPO, ".worktrees", id, ".klh-brief.md"),
			"utf8",
		);
		expect(wtBrief).toContain("GOVERNANCE: UNGOVERNED DISPATCH");
		stub.stop();
	}, 60_000);
});

test("executor unavailable rejects before claim, worktree or key mint", async () => {
	const stub = stubBuckle(true);
	try {
		const id = await addItem("missing executor preclaim fixture");
		const result = await dispatchA(
			{
				SUSPENDERS_CLAUDE_BIN: join(HOME, "does-not-exist"),
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
			},
			"--item",
			id,
		);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("nothing claimed or minted");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
		expect(stub.calls).toEqual([]);
	} finally {
		stub.stop();
	}
}, 60_000);

test("early failed launch releases claim, revokes only its key, preserves baseline and worktree", async () => {
	const stub = stubBuckle(true);
	try {
		const id = await addItem("failed executor owned-key fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		const result = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("executor exited during launch");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		expect(stub.calls.filter((c) => c.endsWith("/revoke"))).toEqual([
			"POST /v1/admin/keys/owned-key/revoke",
		]);
		expect(existsSync(join(REPO, ".fleet", `lane-settings-${sid}.json`))).toBe(
			false,
		);
		expect(existsSync(join(REPO, ".fleet", `lane-key-${sid}.json`))).toBe(
			false,
		);
		expect(
			existsSync(join(REPO, ".worktrees", id, ".fleet/lane-context.json")),
		).toBe(true);
	} finally {
		stub.stop();
	}
}, 60_000);

test("registry persistence failure kills its launched child and cleans its own claim and key", async () => {
	const stub = stubBuckle(true);
	const registry = join(REPO, ".fleet/lanes.json");
	const pidFile = join(HOME, "registry-failure.pid");
	const executor = join(HOME, "registry-failure-executor");
	writeFileSync(
		executor,
		`#!/bin/sh\necho $$ > "${pidFile}"\nmkdir "${registry}"\nexec /bin/sleep 30\n`,
	);
	chmodSync(executor, 0o700);
	rmSync(registry, { recursive: true, force: true });
	try {
		const id = await addItem("registry persistence failure fixture");
		const result = await dispatchA(
			{
				SUSPENDERS_CLAUDE_BIN: executor,
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("launch failed");
		expect(result.out).not.toContain("dispatched ");
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		expect(stub.calls.filter((c) => c.endsWith("/revoke"))).toEqual([
			"POST /v1/admin/keys/owned-key/revoke",
		]);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		rmSync(registry, { recursive: true, force: true });
		stub.stop();
	}
}, 60_000);

test("simultaneous dispatchers launch one harness and loser preserves winner", async () => {
	const pidFile = join(HOME, "overlap-pids");
	const executor = join(HOME, "overlap-executor");
	writeFileSync(
		executor,
		`#!/bin/sh\necho $$ >> "${pidFile}"\nexec /bin/sleep 30\n`,
	);
	chmodSync(executor, 0o700);
	const id = await addItem("overlapping dispatch fixture");
	try {
		const results = await Promise.all([
			dispatchA(
				{ SUSPENDERS_CLAUDE_BIN: executor },
				"--item",
				id,
				"--no-belt",
				"--allow-ungoverned",
			),
			dispatchA(
				{ SUSPENDERS_CLAUDE_BIN: executor },
				"--item",
				id,
				"--no-belt",
				"--allow-ungoverned",
			),
		]);
		expect(results.filter((r) => r.out.includes("dispatched "))).toHaveLength(
			1,
		);
		expect(results.filter((r) => !r.out.includes("dispatched ")).length).toBe(
			1,
		);
		expect(readFileSync(pidFile, "utf8").trim().split("\n")).toHaveLength(1);
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("CLAIMED");
	} finally {
		if (existsSync(pidFile))
			for (const pid of readFileSync(pidFile, "utf8").trim().split("\n")) {
				try {
					process.kill(Number(pid));
				} catch {}
			}
	}
}, 60_000);

test("stale prelease snapshot rereads published live lane after winner releases lease", async () => {
	const id = await addItem("stale dispatcher snapshot fixture");
	const registry = join(REPO, ".fleet/lanes.json");
	rmSync(registry, { force: true });
	const block = join(HOME, "snapshot-block");
	const unblock = join(HOME, "snapshot-release");
	const pidFile = join(HOME, "stale-snapshot-pids");
	const executorDir = join(HOME, "stale-harness");
	mkdirSync(executorDir, { recursive: true });
	const executor = join(executorDir, "claude");
	writeFileSync(
		executor,
		`#!${process.execPath}\nimport {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(pidFile)},String(process.pid)+"\\n");setInterval(()=>{},1000);\n`,
	);
	chmodSync(executor, 0o700);
	const prefix = join(HOME, "stale-prefix");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	for (const name of ["coord.ts", "worktree.ts"])
		symlinkSync(join(BIN, name), join(prefix, "bin", name));
	writeFileSync(
		join(prefix, "bin/work.ts"),
		`import {existsSync,writeFileSync} from "node:fs"; if(process.argv[2]==="lanes"){writeFileSync(${JSON.stringify(block)},"blocked");while(!existsSync(${JSON.stringify(unblock)}))await Bun.sleep(10);console.log("[]");}else{const p=Bun.spawnSync([process.execPath,${JSON.stringify(join(BIN, "work.ts"))},...process.argv.slice(2)],{stdout:"pipe",stderr:"pipe"});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.exitCode);}
`,
	);
	const stale = dispatchA(
		{ SUSPENDERS_PREFIX: prefix, SUSPENDERS_CLAUDE_BIN: executor },
		"--item",
		id,
		"--no-belt",
		"--allow-ungoverned",
	);
	try {
		for (let n = 0; !existsSync(block) && n < 500; n++) await Bun.sleep(10);
		expect(existsSync(block)).toBe(true);
		const winner = await dispatchA(
			{ SUSPENDERS_CLAUDE_BIN: executor },
			"--item",
			id,
			"--no-belt",
			"--allow-ungoverned",
		);
		expect(winner.out).toContain("dispatched ");
		writeFileSync(unblock, "release");
		const loser = await stale;
		expect(loser.out).toContain("durable launch intent alive or uncertain");
		expect(readFileSync(pidFile, "utf8").trim().split("\n")).toHaveLength(1);
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("CLAIMED");
	} finally {
		writeFileSync(unblock, "release");
		await stale;
		if (existsSync(pidFile))
			for (const pid of readFileSync(pidFile, "utf8").trim().split("\n")) {
				try {
					process.kill(Number(pid));
				} catch {}
			}
		rmSync(registry, { force: true });
	}
}, 60_000);

test("custom installed prefix resolves work and coord helpers", () => {
	const prefix = join(HOME, "custom-prefix");
	mkdirSync(prefix, { recursive: true });
	symlinkSync(BIN, join(prefix, "bin"), "dir");
	const id =
		(tool("work.ts", "add", "custom prefix fixture").out.match(/W\d+/) ??
			[])[0] ?? "";
	const result = dispatchWith(
		{ SUSPENDERS_PREFIX: prefix },
		"--item",
		id,
		"--dry-run",
	);
	expect(result.code).toBe(0);
	expect(result.out).toContain(`bun ${prefix}/bin/coord.ts`);
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
