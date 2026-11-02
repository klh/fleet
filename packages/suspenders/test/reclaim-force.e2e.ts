// W2337 CLI regression — the two exits from the unknown-liveness wedge, end
// to end through work.ts: (1) boot-boundary death evidence lets a crash
// reclaim release on its own; (2) a post-boot unknown (no evidence) refuses
// the crash reason but releases under --force --justification with the
// justification audited into the sticky marker.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootEpoch } from "../hooks/lib/lanes/boot-death.ts";

test.describe("@unit", () => {
	const call =
		(root: string) =>
		(...args: string[]) =>
			Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "../hooks/bin/work.ts"),
					...args,
				],
				{
					cwd: root,
					env: { ...process.env, HOME: root, GOVERNOR_STORE_URL: "local" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);

	const markerOf = (
		root: string,
	): { reason: string; justification?: string } | null => {
		const db = new Database(join(root, ".cache/claude-governor/governor.db"));
		try {
			const row = db
				.query("SELECT value FROM facts WHERE key LIKE 'reclaim.reason.%'")
				.get() as { value: string } | null;
			return row ? (JSON.parse(row.value) as { reason: string }) : null;
		} finally {
			db.close();
		}
	};

	/** `work take` claims without a session row (coord bootstrap owns those);
	 * the wedge shape needs the frozen RUNNING row inserted by hand. */
	const seedSession = (
		root: string,
		sid: string,
		startedAt: number,
		hb: number,
	): void => {
		const db = new Database(join(root, ".cache/claude-governor/governor.db"));
		try {
			db.run(
				"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES (?, ?, 'lane', NULL, NULL, ?, ?, 'RUNNING')",
				sid,
				"p",
				startedAt,
				hb,
			);
		} finally {
			db.close();
		}
	};

	test("boot-evidence wedge: crash reclaim releases without force; marker crash", () => {
		const root = mkdtempSync(join(tmpdir(), "fleet-w2337a-"));
		const run = call(root);
		const id =
			run("add", "wedge item").stdout.toString().match(/W\d+/)?.[0] ?? "";
		expect(run("take", id, "--as", "autowed-31").exitCode).toBe(0);
		// seed: RUNNING session frozen pre-boot (the Oct-30 shape), stamped
		// from the LIVE boot epoch so the suite holds on any host
		const at = bootEpoch()?.at;
		expect(Number.isFinite(at)).toBe(true);
		seedSession(
			root,
			"autowed-31",
			(at as number) - 60_000,
			(at as number) - 60_000,
		);
		const crash = run("reclaim", id, "--reason", "crash");
		expect(crash.exitCode, crash.stderr.toString()).toBe(0);
		expect(crash.stdout.toString()).toContain("reclaimed → READY");
		expect(markerOf(root)?.reason).toBe("crash");
	});

	test("post-boot unknown: crash refuses without force; --force --justification releases audited", () => {
		const root = mkdtempSync(join(tmpdir(), "fleet-w2337b-"));
		const run = call(root);
		const id =
			run("add", "cold item").stdout.toString().match(/W\d+/)?.[0] ?? "";
		expect(run("take", id, "--as", "autowed-32").exitCode).toBe(0);
		// post-boot session with cold hb: honest unknown, no death evidence
		const at = bootEpoch()?.at;
		seedSession(
			root,
			"autowed-32",
			(at as number) + 60_000,
			Date.now() - 50 * 60_000,
		);
		const bare = run("reclaim", id, "--reason", "crash");
		expect(bare.exitCode).not.toBe(0);
		expect(bare.stderr.toString()).toContain("death evidence");
		const forced = run(
			"reclaim",
			id,
			"--reason",
			"crash",
			"--force",
			"--justification",
			"machine died Oct 30; claimant transcript silent",
		);
		expect(forced.exitCode, forced.stderr.toString()).toBe(0);
		expect(forced.stdout.toString()).toContain("reclaimed → READY");
		const marker = markerOf(root);
		expect(marker?.reason).toBe("crash");
		expect(marker?.justification).toContain("machine died Oct 30");
	});
});
