// test/session-start-durable-name@unit.e2e.ts — W2863 face (c): the real
// session-start wire stamps a nameless session with the durable
// `<cli>@<short-host>` identity (collision-escaped -2..-9 among live
// holders), so coord consult --to <name> resolves without raw sids. Rides
// the kit (W1135.1.3); spawns the real hook against a scratch world, the
// session-start-lane.e2e.ts idiom.
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	computeDurableName,
	shortHostname,
} from "../hooks/lib/lanes/durable-lane-name.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";

const world = scratchWorld({ prefix: "durable-name-" });
const hook = join(import.meta.dir, "..", "hooks", "session-start.ts");
const DB = join(world.home, ".cache", "claude-governor", "governor.db");

const env: Record<string, string | undefined> = { ...world.env };
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
env.SUSPENDERS_BUCKLE_FRONT = "http://127.0.0.1:1";
env.SUSPENDERS_BELT_ENV = join(world.home, "absent-belt.env");

const nameOf = (sid: string): string | null => {
	const db = new Database(DB, { read: true });
	try {
		const row = db
			.query("SELECT tags FROM sessions WHERE sid = ?")
			.get(sid) as { tags: string | null } | null;
		if (!row?.tags) return null;
		const tags = JSON.parse(row.tags) as Record<string, unknown>;
		return typeof tags.name === "string" ? tags.name : null;
	} finally {
		db.close();
	}
};

const runHook = (sid: string): void => {
	const payload = join(world.home, `payload-${sid}.json`);
	mkdirSync(world.home, { recursive: true });
	writeFileSync(
		payload,
		JSON.stringify({
			session_id: sid,
			source: "startup",
			cwd: world.repo,
		}),
	);
	const r = Bun.spawnSync(["bun", hook], {
		cwd: world.repo,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) {
		throw new Error(
			`session-start exited ${r.exitCode}: ${r.stderr.toString()}`,
		);
	}
};

test.describe("@unit", () => {
	test("shortHostname + computeDurableName are the stable identity shape", () => {
		expect(shortHostname("MBP.local.")).toBe("mbp");
		expect(shortHostname("x.y.local")).toBe("x.y");
		expect(shortHostname("   ")).toBe("localhost");
		expect(computeDurableName("pi", "muramasa")).toBe("pi@muramasa");
	});

	test("real bootstrap stamps the durable name on a nameless session", () => {
		const sid = "dname-11111111";
		runHook(sid);
		expect(nameOf(sid)).toBe(computeDurableName("claude", shortHostname()));
	});

	test("second bootstrap on the same session keeps the name (idempotent)", () => {
		const sid = "dname-22222222";
		runHook(sid);
		const first = nameOf(sid);
		runHook(sid);
		expect(nameOf(sid)).toBe(first);
	});

	test("a live holder of the base name collision-escapes the next session to -2", () => {
		const seed = "dname-33333333";
		// isolate the ladder: drop the earlier tests' sessions, then seed ONE
		// live holder of the base name BEFORE the latecomer's bootstrap
		const db = new Database(DB);
		try {
			db.query("DELETE FROM sessions").run();
			db.query(
				"INSERT INTO sessions (sid, project, role, state, started_at, hb, tags) VALUES (?, ?, 'worker', 'RUNNING', ?, ?, ?)",
			).run(
				seed,
				projectIdentity(world.repo),
				Date.now(),
				Date.now(),
				JSON.stringify({ name: computeDurableName("claude", shortHostname()) }),
			);
		} finally {
			db.close();
		}
		const latecomer = "dname-44444444";
		runHook(latecomer);
		expect(nameOf(latecomer)).toBe(
			`${computeDurableName("claude", shortHostname())}-2`,
		);
	});

	test.afterAll(() => {
		world.clean();
	});
});
