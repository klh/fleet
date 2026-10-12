// fail-closed governance (W463): mint/refuse e2e, launch cleanup, lease

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../../hooks/lib/govdb.ts";
import { laneSid } from "../../hooks/lib/laneslug.ts";
import { laneKeyDecision } from "../../scripts/dispatch-next.ts";
import {
	HOME,
	REPO,
	BIN,
	tool,
	dispatchWith,
	stubBuckle,
	toolA,
	dispatchA,
	addItem,
} from "./fixtures.ts";

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
			expect((await toolA({}, "worktree.ts", "create", id)).code).toBe(0);
			mkdirSync(join(REPO, ".fleet"), { recursive: true });
			const metaPath = join(REPO, ".fleet", `lane-key-${sid}.json`);
			const settingsPath = join(REPO, ".fleet", `lane-settings-${sid}.json`);
			writeFileSync(
				metaPath,
				JSON.stringify({ sid, key_id: "deadbeefcafe", mintedAt: 1 }),
			);
			writeFileSync(settingsPath, "{}");
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

