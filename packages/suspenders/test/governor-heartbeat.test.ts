// W613 pin: the governor gate's heartbeat rides openStore() — the store that
// HOLDS the claims — rate-limited to one write per 60 s (remote writes are
// curl spawns), clock in the governor cache, fail-open on store errors.
// Each probe runs in a SUBPROCESS with its own HOME/store env: laneHeartbeat
// bakes REG at module import, and batch runs share one process.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "..", "hooks", "gates", "governor.ts");
const SCRIPT = `
	const { existsSync } = await import("node:fs");
	const { laneHeartbeat } = await import(process.argv[2]);
	const govdb = await import(process.argv[2].replace("gates/governor.ts", "lib/govdb.ts"));
	let store = null;
	try {
		store = govdb.openStore();
		store.run("CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')");
		store.run("INSERT OR REPLACE INTO sessions (sid, project, started_at, hb) VALUES ('autow-hb', 'p', 1, 1)");
	} catch {}
	const t0 = Date.now();
	let threw = false;
	try {
		laneHeartbeat("autow-hb", t0);
		laneHeartbeat("autow-hb", t0 + 1000); // inside the 60 s window — must be skipped
	} catch {
		threw = true;
	}
	const row = store?.query("SELECT hb FROM sessions WHERE sid = 'autow-hb'").get();
	const clock = \`\${process.env.HOME}/.cache/claude-governor/hb-clock.json\`;
	console.log(JSON.stringify({ threw, hb: row?.hb ?? null, t0, clock: existsSync(clock) }));
`;

describe("governor heartbeat binding (W613)", () => {
	test("hb reaches the claim store, rate-limited to 1/60s", () => {
		const HOME = mkdtempSync(join(tmpdir(), "suspenders-hb-"));
		mkdirSync(join(HOME, "repo", ".git"), { recursive: true });
		try {
			const r = Bun.spawnSync(["bun", "-e", SCRIPT, "x", GATE], {
				env: { ...process.env, HOME, GOVERNOR_STORE_URL: "local" },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(r.exitCode).toBe(0);
			const { threw, hb, t0, clock } = r.stdout.length
				? (JSON.parse(r.stdout.toString().trim()) as {
						threw: boolean;
						hb: number;
						t0: number;
						clock: boolean;
					})
				: { threw: true, hb: -1, t0: 0, clock: false };
			expect(threw).toBe(false);
			expect(hb).toBe(t0); // second write inside the window was rate-limited
			expect(clock).toBe(true); // the clock landed in the governor cache
		} finally {
			rmSync(HOME, { recursive: true, force: true });
		}
	});

	test("dead store never blocks — hb write fails open", () => {
		const HOME = mkdtempSync(join(tmpdir(), "suspenders-hb-"));
		mkdirSync(join(HOME, "repo", ".git"), { recursive: true });
		try {
			const r = Bun.spawnSync(["bun", "-e", SCRIPT, "x", GATE], {
				env: { ...process.env, HOME, GOVERNOR_STORE_URL: "http://127.0.0.1:9" },
				stdout: "pipe",
				stderr: "pipe",
			});
			// no throw = fail-open held: laneHeartbeat swallowed the dead store
			const out = r.stdout.length
				? (JSON.parse(r.stdout.toString().trim()) as { threw: boolean })
				: { threw: true };
			expect(out.threw).toBe(false);
		} finally {
			rmSync(HOME, { recursive: true, force: true });
		}
	});
});
