// test/dispatch-next-lifecycle.test.ts — W1137: crash-resume budget split
// out of dispatch-next.test.ts (the 1500-line decomposition; pure moves).
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb.ts";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { HOME, REPO, dispatchWith, tool, dispatch } = dispatchHarness(afterAll, {
	tag: "w145-dispatch",
	beltEnv: true,
});

const expireLaunchHold = (id: string): void => {
	const db = new Database(
		join(HOME, ".cache", "claude-governor", "governor.db"),
	);
	db.query(
		"UPDATE facts SET value=json_set(value,'$.eligibleAt',0) WHERE key LIKE ?",
	).run(`dispatch.launch-backoff.%.${id}`);
	db.close();
};

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
