import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shared = join(import.meta.dir, "..", "hooks", "coord", "shared.ts");
const bus = join(import.meta.dir, "..", "hooks", "coord", "bus.ts");

test("subscriber liveness uses the registered transcript or heartbeat for any client", () => {
	const home = mkdtempSync(join(tmpdir(), "subscriber-liveness-"));
	const first = join(home, "client-a.jsonl");
	const second = join(home, "client-b.jsonl");
	writeFileSync(first, "a");
	writeFileSync(second, "b");
	const stale = new Date(Date.now() - 60 * 60_000);
	utimesSync(second, stale, stale);
	try {
		const script = `
const { db } = await import(${JSON.stringify(shared)});
const { subscriberSessionAlive } = await import(${JSON.stringify(bus)});
const now = Date.now();
const insert = db.query("INSERT INTO sessions (sid, project, started_at, hb, state, transcript_path) VALUES (?, 'test', ?, ?, ?, ?)");
insert.run('client-a', now, now - 3600000, 'RUNNING', ${JSON.stringify(first)});
insert.run('client-b', now, now, 'RUNNING', ${JSON.stringify(second)});
insert.run('client-c', now, now - 3600000, 'RUNNING', null);
insert.run('client-d', now, now, 'CLOSED', ${JSON.stringify(first)});
console.log(JSON.stringify(['client-a','client-b','client-c','client-d'].map((sid) => subscriberSessionAlive(sid, now))));
`;
		const result = Bun.spawnSync(["bun", "-e", script], {
			env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: "local" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString().trim())).toEqual([
			true,
			true,
			false,
			false,
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
