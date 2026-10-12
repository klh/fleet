// crash resume: orphan claims, ownership-safe failure, bounded attempts,

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../../hooks/lib/govdb.ts";
import { laneSid } from "../../hooks/lib/laneslug.ts";
import {
	HOME,
	REPO,
	tool,
	dispatchWith,
	dispatch,
} from "./fixtures.ts";

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
		expect(dispatchWith(extra, "--item", id).out).toContain(
			"launch budget exhausted",
		);
		expect(dispatchWith(extra, "--item", id).out).not.toContain("(pid");
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
		const preview = dispatch("--dry-run", "--item", id);
		expect(preview.out).toContain("resume budget exhausted");
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"CLAIMED"',
		);
		const result = dispatch("--item", id);
		expect(result.out).toContain("resume budget exhausted");
		expect(result.out).not.toContain("REFUSED");
		expect(tool("work.ts", "show", id, "--json").out).toContain(
			'"state":"FAILED"',
		);
		expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
		rmSync(join(fleet, "lanes.json"));
	}, 60_000);
});
