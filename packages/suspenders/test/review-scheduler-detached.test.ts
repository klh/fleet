// W1243.1 (#62654): the scheduler launched reviewers with child.unref() but
// no detached:true — a short-lived parent CLI took the reviewer with it,
// stranding the RUNNING lease (HTTP499-at-launch audit rows). The regression
// proof spawns a SHORT-LIVED PARENT process that calls the real
// launchDetachedReview, then requires the reviewer child to outlive it.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	finishReviewRequest,
	launchDetachedReview,
	reviewLaunchLogPath,
} from "../hooks/lib/gates/review-scheduler.ts";
import { openMemoryStore } from "../hooks/lib/govdb/govdb-store.ts";

// spawn-heavy suite: file-level budget (bun test runs files in one process)
setDefaultTimeout(30_000);

const schedulerUrl = new URL(
	"../hooks/lib/gates/review-scheduler.ts",
	import.meta.url,
).pathname;

const childFixture = (
	[
		"// reviewer stand-in: proves aliveness by writing a marker late",
		"const marker = process.argv[2];",
		"const delayMs = Number(process.argv[3]);",
		"await Bun.sleep(delayMs);",
		'await Bun.write(marker, "alive");',
	] satisfies string[]
).join("\n");

const parentFixture = (): string =>
	[
		`import { launchDetachedReview } from ${JSON.stringify(schedulerUrl)};`,
		"const childScript = process.argv[2];",
		"const logPath = process.argv[3];",
		"process.env.SUSPENDERS_REVIEW_LAUNCH_LOG = logPath;",
		"launchDetachedReview(",
		'[process.execPath, childScript, process.argv[4], "1500"],',
		"{ ...process.env },",
		'process.argv[5] ?? ".",',
		");",
		"// parent CLI exits immediately — the reviewer must not die with it",
	].join("\n");

test("detached reviewer survives a short-lived parent CLI", async () => {
	const dir = mkdtempSync(join(tmpdir(), "review-detach-"));
	try {
		const child = join(dir, "child.ts");
		const parent = join(dir, "parent.ts");
		const marker = join(dir, "marker.txt");
		const log = join(dir, "launch.log");
		writeFileSync(child, childFixture);
		writeFileSync(parent, parentFixture());
		const started = Date.now();
		const p = Bun.spawnSync(
			[process.execPath, parent, child, log, marker, dir],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const parentWall = Date.now() - started;
		expect(p.exitCode).toBe(0);
		expect(p.stderr.toString()).toBe("");
		// parent exited well inside the child's 1500 ms delay, so a marker
		// can only come from a child that outlived its parent
		expect(parentWall).toBeLessThan(1500);
		let alive = false;
		for (let waited = 0; waited < 10_000; waited += 100) {
			if (await Bun.file(marker).exists()) {
				alive = true;
				break;
			}
			await Bun.sleep(100);
		}
		expect(alive).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("launch stderr is captured to the configured log file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "review-log-"));
	const previous = process.env.SUSPENDERS_REVIEW_LAUNCH_LOG;
	process.env.SUSPENDERS_REVIEW_LAUNCH_LOG = join(dir, "launch.log");
	try {
		const err = join(dir, "child-err.ts");
		writeFileSync(
			err,
			[
				'console.error("boom: reviewer died at launch");',
				"process.exit(3);",
			].join("\n"),
		);
		const child = launchDetachedReview(
			[process.execPath, err],
			{ ...process.env },
			dir,
		);
		await child.exited;
		const text = await Bun.file(reviewLaunchLogPath()).text();
		expect(text).toContain("review launch pid=");
		expect(text).toContain("boom: reviewer died at launch");
	} finally {
		if (previous === undefined) delete process.env.SUSPENDERS_REVIEW_LAUNCH_LOG;
		else process.env.SUSPENDERS_REVIEW_LAUNCH_LOG = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("finishReviewRequest never re-finishes a closed request", () => {
	const db = openMemoryStore();
	try {
		db.run(
			"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
		);
		const request = {
			state: "RUNNING",
			attempts: 1,
			leaseUntil: 0,
			token: "t1",
			nextAt: 0,
		};
		db.query("INSERT INTO facts VALUES ('k', ?, 's', 1, 0)").run(
			JSON.stringify(request),
		);
		finishReviewRequest(db, "k", "t1", true);
		const once = JSON.parse(
			(
				db.query("SELECT value FROM facts WHERE key='k'").get() as {
					value: string;
				}
			).value,
		) as { state: string; attempts: number; deferred: number };
		expect(once.state).toBe("ERROR");
		expect(once.deferred).toBe(1);
		// second finish (e.g. the runner's own receipt racing the watchdog)
		// must be a no-op — no double refund, no DONE flip
		finishReviewRequest(db, "k", "t1", false);
		const twice = JSON.parse(
			(
				db.query("SELECT value FROM facts WHERE key='k'").get() as {
					value: string;
				}
			).value,
		) as { state: string };
		expect(twice.state).toBe("ERROR");
	} finally {
		db.close();
	}
});
