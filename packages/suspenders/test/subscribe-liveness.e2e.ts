import { expect, test } from "@playwright/test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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

test("a stale paused managed native owner retains its subscriber, not unrelated or dead PIDs", async () => {
	const home = mkdtempSync(join(tmpdir(), "paused-subscriber-"));
	const script = join(home, "claude");
	const sid = "managed-paused-owner";
	writeFileSync(script, "setInterval(() => {}, 1000);");
	const child = Bun.spawn([process.execPath, script, sid], {
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		mkdirSync(join(home, ".fleet"));
		writeFileSync(
			join(home, ".fleet", "lanes.json"),
			JSON.stringify([{ sid, item: "W1", pid: child.pid }]),
		);
		const source = `const {db}=await import(${JSON.stringify(shared)}); const {subscriberSessionAlive}=await import(${JSON.stringify(bus)}); const now=Date.now(); db.query("INSERT OR REPLACE INTO sessions(sid,project,started_at,hb,state) VALUES(?,?,?,?,'RUNNING')").run(${JSON.stringify(sid)},${JSON.stringify(home)},now,now-3600000); db.query("INSERT OR REPLACE INTO facts(key,value,source,version,ts) VALUES(?, 'PAUSED','test',1,?)").run('lane.'+${JSON.stringify(sid)}+'.state',now); console.log(JSON.stringify(subscriberSessionAlive(${JSON.stringify(sid)},now)));`;
		const check = () =>
			Bun.spawnSync([process.execPath, "-e", source], {
				env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: "local" },
				stdout: "pipe",
				stderr: "pipe",
			});
		let result = check();
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("true");
		writeFileSync(
			join(home, ".fleet", "lanes.json"),
			JSON.stringify([{ sid, item: "W1", pid: process.pid }]),
		);
		result = check();
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("false");
		writeFileSync(
			join(home, ".fleet", "lanes.json"),
			JSON.stringify([{ sid, item: "W1", pid: child.pid }]),
		);
		child.kill();
		await child.exited;
		result = check();
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("false");
	} finally {
		child.kill();
		rmSync(home, { recursive: true, force: true });
	}
});

test("control catch-up follows current lifecycle and never replays accepted or obsolete controls", () => {
	const home = mkdtempSync(join(tmpdir(), "subscriber-control-"));
	try {
		const source = `const {db}=await import(${JSON.stringify(shared)}); const {subscriberPendingControl}=await import(${JSON.stringify(bus)}); const sid='control-owner'; const state=db.query("INSERT OR REPLACE INTO facts(key,value,source,version,ts) VALUES('lane.control-owner.state',?,'test',1,?)"); const event=db.query("INSERT INTO events(ts,source,kind,payload,target) VALUES(?,'test',?,'{}',?)"); event.run(1,'pause_requested',sid); event.run(2,'resume_ready',sid); event.run(3,'resume_ready',sid); state.run('RESUME_READY',2); const resume=subscriberPendingControl(sid); console.log(resume.kind); console.log(resume.ts); db.query("INSERT INTO direct_message_receipts(event_id,sid,state,queued_at) VALUES(?,?,'ACCEPTED',2)").run(resume.id,sid); console.log(subscriberPendingControl(sid)); state.run('RUNNING',3); console.log(subscriberPendingControl(sid)); state.run('PAUSE_REQUESTED',4); console.log(subscriberPendingControl(sid).kind);`;
		const result = Bun.spawnSync([process.execPath, "-e", source], {
			env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: "local" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim().split("\n")).toEqual([
			"resume_ready",
			"3",
			"null",
			"null",
			"pause_requested",
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
