import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	acquireLaunchLease,
	releaseLaunchLease,
} from "../scripts/lib/launch-preflight.ts";
import {
	fencedExecutor,
	finishFailedLaunch,
	heldLaunchItems,
	inspectLaunchIntent,
	launchIntent,
	processBirth,
	registerLaunch,
	reserveLaunchIntent,
	terminateOwnLaunch,
	type LaunchIntent,
} from "../scripts/lib/launch-fencing.ts";
const dirs: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
	await Promise.all(children.splice(0).map(terminateOwnLaunch));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,owner_sid TEXT,updated_at INTEGER,state TEXT)",
	);
	db.run("INSERT INTO work_items VALUES ('project','W1','lane',100,'CLAIMED')");
	const store = db as unknown as GovernorStore;
	acquireLaunchLease(store, "project", "lane", "nonce");
	const input = {
		project: "project",
		item: "W1",
		sid: "lane",
		nonce: "nonce",
		revision: 100,
		executor: process.execPath,
	};
	return { db, store, input };
}
test("reserved pre-fork intent holds slot and blocks lease-expiry or SID-transfer replay", () => {
	const { db, store, input } = fixture();
	const intent = reserveLaunchIntent(store, input, 3);
	expect(intent.attempt).toBe(0);
	expect(inspectLaunchIntent(intent)).toBe("unknown");
	expect([...heldLaunchItems(store, "project")]).toEqual(["W1"]);
	releaseLaunchLease(store, "project", "lane", "nonce");
	acquireLaunchLease(store, "project", "other", "replacement");
	db.run("UPDATE work_items SET owner_sid='other',updated_at=101");
	expect(() =>
		reserveLaunchIntent(
			store,
			{ ...input, sid: "other", nonce: "replacement", revision: 101 },
			3,
		),
	).toThrow("uncertain");
	expect(() => registerLaunch(store, intent, process.pid)).toThrow(
		"lease replaced",
	);
});
test("item budget survives SID changes, reclaim and process restart", () => {
	const { db, store, input } = fixture();
	for (let n = 0; n < 3; n++) {
		const sid = `lane${n}`;
		const nonce = `nonce${n}`;
		db.query("UPDATE work_items SET owner_sid=?,updated_at=?").run(
			sid,
			100 + n,
		);
		acquireLaunchLease(store, "project", sid, nonce);
		const intent = reserveLaunchIntent(
			store,
			{ ...input, sid, nonce, revision: 100 + n },
			3,
		);
		expect(intent.attempt).toBe(n);
		finishFailedLaunch(store, intent);
	}
	expect(() =>
		reserveLaunchIntent(
			store,
			{ ...input, sid: "lane2", nonce: "nonce2", revision: 102 },
			3,
		),
	).toThrow("budget exhausted");
	expect(
		db.query("SELECT reservations FROM lane_launch_budgets").get(),
	).toEqual({ reservations: 3 });
});
test("claim revision and nonce fence registration and older cleanup", () => {
	const { db, store, input } = fixture();
	const first = reserveLaunchIntent(store, input, 3);
	db.run("UPDATE work_items SET updated_at=101");
	expect(() => registerLaunch(store, first, process.pid)).toThrow(
		"claim replaced",
	);
	finishFailedLaunch(store, first);
	const second = reserveLaunchIntent(store, { ...input, revision: 101 }, 3);
	finishFailedLaunch(store, { ...first, nonce: "older" });
	expect(launchIntent(store, "project", "W1")?.state).toBe("PREPARING");
	registerLaunch(store, second, process.pid);
	expect(launchIntent(store, "project", "W1")?.pid).toBe(process.pid);
	expect(() => registerLaunch(store, second, process.pid)).toThrow(
		"intent replaced",
	);
});
test("process truth checks birth plus actual executable, never prompt words", () => {
	const intent: LaunchIntent = {
		...fixture().input,
		attempt: 0,
		state: "REGISTERED",
		host: hostname(),
		pid: 42,
		birth: "boot:123",
	};
	const fake =
		(command: string, birth = "boot:123") =>
		() => ({ birth, command });
	expect(
		inspectLaunchIntent(intent, fake(`${intent.executor} script.ts`)),
	).toBe("alive");
	expect(
		inspectLaunchIntent(
			intent,
			fake(`/usr/bin/other prompt ${intent.executor}`),
		),
	).toBe("unknown");
	expect(inspectLaunchIntent(intent, fake(intent.executor, "boot:456"))).toBe(
		"dead",
	);
	expect(inspectLaunchIntent(intent, () => null)).toBe("unknown");
	expect(
		inspectLaunchIntent({ ...intent, host: "remote-host" }, () => false),
	).toBe("unknown");
	expect(inspectLaunchIntent(intent, () => false)).toBe("dead");
});
test("hostname flip (.localdomain -> .local) stays same machine, fencing intact", () => {
	const base = hostname().replace(/\.local(?:domain)?$/i, "");
	const preFlip: LaunchIntent = {
		...fixture().input,
		attempt: 0,
		state: "REGISTERED",
		host: `${base}.localdomain`,
		pid: 42,
		birth: "boot:123",
	};
	const fake =
		(command: string, birth = "boot:123") =>
		() => ({ birth, command });
	// same machine through the flip: birth fencing decides, not the suffix
	expect(
		inspectLaunchIntent(preFlip, fake(`${preFlip.executor} script.ts`)),
	).toBe("alive");
	expect(inspectLaunchIntent(preFlip, fake(preFlip.executor, "boot:456"))).toBe(
		"dead",
	);
	// a genuinely foreign host is still uninspectable — fail-closed preserved
	expect(
		inspectLaunchIntent({ ...preFlip, host: "other-mac.local" }, () => false),
	).toBe("unknown");
});
function privateRuntime() {
	const home = mkdtempSync(join(tmpdir(), "fleet-launch-fence-"));
	dirs.push(home);
	const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "local" };
	const gov = join(import.meta.dir, "../hooks/lib/govdb.ts");
	const init = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`import {openStore} from ${JSON.stringify(gov)}; const s=openStore(); s.query("INSERT INTO work_items(project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("project","W1","fixture","CLAIMED","lane",100,100);s.close();`,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	if (init.exitCode !== 0) throw new Error(init.stderr.toString());
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	const store = db as unknown as GovernorStore;
	acquireLaunchLease(store, "project", "lane", "nonce");
	const exe = join(home, "executor.ts"),
		marker = join(home, "ran");
	writeFileSync(
		exe,
		`#!${process.execPath}\nimport {existsSync} from "node:fs";process.on("SIGTERM",()=>{});await Bun.write(${JSON.stringify(marker)},"ran");const until=Date.now()+5000;setInterval(()=>{if(existsSync(${JSON.stringify(join(home, "stop"))})||Date.now()>until)process.exit(0)},20);`,
	);
	chmodSync(exe, 0o700);
	const intent = reserveLaunchIntent(
		store,
		{
			project: "project",
			item: "W1",
			sid: "lane",
			nonce: "nonce",
			revision: 100,
			executor: exe,
		},
		3,
	);
	return { home, env, db, store, intent, marker };
}
async function waitMarker(marker: string) {
	for (let n = 0; n < 100 && !existsSync(marker); n++) await Bun.sleep(20);
	expect(existsSync(marker)).toBe(true);
}
test("parent death after reservation before fork is held, no executor ran", () => {
	const f = privateRuntime();
	expect(existsSync(f.marker)).toBe(false);
	expect(
		inspectLaunchIntent(launchIntent(f.store, "project", "W1") as LaunchIntent),
	).toBe("unknown");
	f.db.close();
});
test("wrapper registers before exec; parent absent before registry still cannot duplicate", async () => {
	const f = privateRuntime();
	const wrapper = fencedExecutor(f.home, f.intent);
	const child = Bun.spawn([wrapper], {
		env: f.env,
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	await waitMarker(f.marker);
	const receipt = launchIntent(f.store, "project", "W1") as LaunchIntent;
	expect(receipt.pid).toBe(child.pid);
	expect(receipt.birth).toBeTruthy();
	expect(processBirth(child.pid)).not.toBe(false);
	expect(inspectLaunchIntent(receipt)).toBe("alive");
	releaseLaunchLease(f.store, "project", "lane", "nonce");
	acquireLaunchLease(f.store, "project", "lane", "replacement");
	expect(() =>
		reserveLaunchIntent(f.store, { ...f.intent, nonce: "replacement" }, 3),
	).toThrow("alive or uncertain");
	await terminateOwnLaunch(child);
	expect(await child.exited).toBeGreaterThan(0);
	expect(inspectLaunchIntent(receipt)).toBe("dead");
	f.db.close();
});
test("replaced lease fails closed before executable side effects", async () => {
	const f = privateRuntime();
	const wrapper = fencedExecutor(f.home, f.intent);
	releaseLaunchLease(f.store, "project", "lane", "nonce");
	const child = Bun.spawn([wrapper], {
		env: f.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	expect(await child.exited).toBe(125);
	expect(existsSync(f.marker)).toBe(false);
	expect(await new Response(child.stderr).text()).toContain(
		"harness was not started",
	);
	expect(inspectLaunchIntent(f.intent)).toBe("unknown");
	f.db.close();
});
test("configured remote registration outage cannot fall back to local store", async () => {
	const f = privateRuntime();
	const wrapper = fencedExecutor(f.home, f.intent);
	const child = Bun.spawn([wrapper], {
		env: { ...f.env, GOVERNOR_STORE_URL: "http://127.0.0.1:1" },
		stdout: "ignore",
		stderr: "ignore",
	});
	children.push(child);
	expect(await child.exited).toBe(125);
	expect(existsSync(f.marker)).toBe(false);
	expect(launchIntent(f.store, "project", "W1")?.state).toBe("PREPARING");
	f.db.close();
});

for (const phase of ["before-fork", "after-fork", "after-register"] as const) {
	test(`actual parent SIGKILL at ${phase} preserves authoritative launch fence`, async () => {
		const f = privateRuntime(),
			wrapper = fencedExecutor(f.home, f.intent),
			phaseFile = join(f.home, "phase");
		if (phase === "after-fork")
			writeFileSync(
				wrapper,
				readFileSync(wrapper, "utf8").replace(
					"#!/bin/sh\n",
					"#!/bin/sh\nsleep 0.5\n",
				),
			);
		const parentCode = `const phase=${JSON.stringify(phase)};if(phase!=="before-fork"){const child=Bun.spawn([${JSON.stringify(wrapper)}],{env:process.env,detached:true,stdout:"ignore",stderr:"ignore",stdin:"ignore"});child.unref();if(phase==="after-register")while(!(await Bun.file(${JSON.stringify(f.marker)}).exists()))await Bun.sleep(10);}await Bun.write(${JSON.stringify(phaseFile)},"ready");setInterval(()=>{},1000);`;
		const parent = Bun.spawn([process.execPath, "-e", parentCode], {
			env: f.env,
			stdout: "ignore",
			stderr: "ignore",
		});
		children.push(parent);
		try {
			await waitMarker(phaseFile);
			await terminateOwnLaunch(parent);
			if (phase !== "before-fork") await waitMarker(f.marker);
			const intent = launchIntent(f.store, "project", "W1") as LaunchIntent;
			expect(inspectLaunchIntent(intent)).toBe(
				phase === "before-fork" ? "unknown" : "alive",
			);
			releaseLaunchLease(f.store, "project", "lane", "nonce");
			acquireLaunchLease(f.store, "project", "lane", "replacement");
			expect(() =>
				reserveLaunchIntent(f.store, { ...f.intent, nonce: "replacement" }, 3),
			).toThrow("alive or uncertain");
			expect([...heldLaunchItems(f.store, "project")]).toEqual(["W1"]);
		} finally {
			writeFileSync(join(f.home, "stop"), "stop");
			const intent = launchIntent(f.store, "project", "W1");
			if (intent?.pid)
				for (let i = 0; i < 150 && processBirth(intent.pid) !== false; i++)
					await Bun.sleep(20);
			f.db.close();
		}
	}, 10000);
}
