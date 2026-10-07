import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	reserveRecovery,
	resetRecovery,
} from "../hooks/lib/dead-claim-recovery.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

test("CLI reclaim pins observed revision and publishes exact committed receipt", () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-recovery-contract-"));
	try {
		const run = (bin: string, ...args: string[]) =>
			Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, `../hooks/bin/${bin}.ts`),
					...args,
				],
				{
					cwd: home,
					env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: "local" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
		const id =
			run("work", "add", "private fixture")
				.stdout.toString()
				.match(/W\d+/)?.[0] ?? "";
		expect(run("work", "take", id, "--as", "fixture-owner").exitCode).toBe(0);
		const before = JSON.parse(
			run("work", "show", id, "--json").stdout.toString(),
		);
		expect(
			run(
				"work",
				"reclaim",
				id,
				"--expect-owner",
				"fixture-owner",
				"--expect-updated-at",
				String(before.updated_at - 1),
				"--json",
			).exitCode,
		).not.toBe(0);
		expect(
			JSON.parse(run("work", "show", id, "--json").stdout.toString()).state,
		).toBe("CLAIMED");
		const released = run(
			"work",
			"reclaim",
			id,
			"--expect-owner",
			"fixture-owner",
			"--expect-updated-at",
			String(before.updated_at),
			"--json",
		);
		expect(released.exitCode, released.stderr.toString()).toBe(0);
		expect(JSON.parse(released.stdout.toString())).toEqual({
			project: before.project,
			id,
			previousOwner: "fixture-owner",
			previousUpdatedAt: before.updated_at,
			released: true,
		});
		const db = new Database(join(home, ".cache/claude-governor/governor.db"));
		const store = db as unknown as GovernorStore;
		reserveRecovery(
			store,
			before.project,
			id,
			"fixture-owner",
			before.updated_at,
		);
		const target = `${before.project}-rekeyed`;
		reserveRecovery(store, target, "W999", "other-owner", 1);
		expect(
			run("coord", "project", "rekey", before.project, target).exitCode,
		).not.toBe(0);
		expect(
			db
				.query(
					"SELECT attempts FROM work_recovery_attempts WHERE project=? AND id=?",
				)
				.get(before.project, id),
		).toEqual({ attempts: 1 });
		resetRecovery(store, target, "W999");
		expect(
			run("coord", "project", "rekey", before.project, target).exitCode,
		).toBe(0);
		expect(
			db
				.query(
					"SELECT attempts FROM work_recovery_attempts WHERE project=? AND id=?",
				)
				.get(target, id),
		).toEqual({ attempts: 1 });
		expect(
			db
				.query("SELECT attempts FROM work_recovery_attempts WHERE project=?")
				.get(before.project),
		).toBeNull();
		db.close();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("separate supervisors atomically reserve at most three durable item recovery tokens", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-recovery-race-"));
	try {
		const path = join(root, "private.db");
		const db = new Database(path);
		db.run(
			"CREATE TABLE events(id INTEGER PRIMARY KEY,ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
		);
		reserveRecovery(db as unknown as GovernorStore, "p", "W1", "seed", 1);
		resetRecovery(db as unknown as GovernorStore, "p", "W1");
		db.close();
		const script = `import {Database} from 'bun:sqlite'; import {reserveRecovery} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/dead-claim-recovery.ts"))};const db=new Database(process.argv[1]);db.run('PRAGMA busy_timeout=5000');console.log(reserveRecovery(db,'p','W1',process.argv[2],1));db.close();`;
		const outcomes = await Promise.all(
			Array.from({ length: 8 }, async (_, index) => {
				const child = Bun.spawn(
					[process.execPath, "-e", script, path, `owner${index}`],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const [code, out, error] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(code, error).toBe(0);
				return out.trim() === "true";
			}),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(3);
		const reopened = new Database(path);
		expect(
			reopened.query("SELECT attempts FROM work_recovery_attempts").get(),
		).toEqual({ attempts: 3 });
		expect(
			reserveRecovery(
				reopened as unknown as GovernorStore,
				"p",
				"W1",
				"new-owner",
				2,
			),
		).toBe(false);
		reopened.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
