import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	unlinkSync,
	appendFileSync,
	realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";
import { projectIdentity } from "../hooks/lib/govdb-project.ts";
import { pausedNativeBoundary } from "../hooks/lib/claude-restart.ts";

async function exerciseSubscriberLifecycle(mode: "claim" | "watcher") {
	const f = pausedLaneFixture(`wtest-claim-${crypto.randomUUID()}`);
	const reserve = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = reserve.port;
	reserve.stop(true);
	const url = `http://127.0.0.1:${port}`;
	const server = Bun.spawn(
		[
			process.execPath,
			join(f.hooks, "bin/store-server.ts"),
			"--port",
			String(port),
		],
		{ env: f.env, stdout: "ignore", stderr: "ignore" },
	);
	let runtime: ReturnType<typeof Bun.spawn> | undefined;
	const env = {
		...f.env,
		GOVERNOR_STORE_URL: url,
		SUSPENDERS_CLAUDE_NATIVE_BIN: join(
			import.meta.dir,
			"fixtures/claude-stream-pause.ts",
		),
		SUSPENDERS_FIXTURE_ACK_PAUSE: "1",
		SUSPENDERS_FIXTURE_NATIVE_UUID: crypto.randomUUID(),
	};
	const frames: Record<string, unknown>[] = [];
	const wakeDir = join(f.home, ".claude-insights", "coord-claude-wake");
	const lock = join(
		wakeDir,
		`${createHash("sha256").update(f.sid).digest("hex")}.managed.watcher.json`,
	);
	const call = async (args: string[]) => {
		const child = Bun.spawn([process.execPath, ...args], {
			cwd: f.cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw Error(`${out}\n${err}`);
		return out;
	};
	const coord = (...args: string[]) =>
		call([join(f.hooks, "bin/coord.ts"), ...args, "--as", f.sid]);
	const subscriber = async (action: string) =>
		call([
			"-e",
			`const m=await import(${JSON.stringify(join(f.hooks, "lib/subscribe-attach.ts"))}); console.log(m.${action}(${JSON.stringify(f.sid)}));`,
		]);
	try {
		for (let i = 0; i < 50; i++) {
			if (
				await fetch(`${url}/health`)
					.then((r) => r.ok)
					.catch(() => false)
			)
				break;
			if (i === 49) throw Error("isolated store unavailable");
			await Bun.sleep(20);
		}
		const rpc = async (sql: string, params: unknown[]) => {
			const response = await fetch(`${url}/rpc`, {
				method: "POST",
				body: JSON.stringify({ mode: "run", sql, params }),
			});
			if (!response.ok) throw Error(await response.text());
			return response.json();
		};
		await rpc(
			"INSERT OR REPLACE INTO sessions(sid,project,started_at,hb,state,tags) VALUES(?,?,?,?,'RUNNING','{}')",
			[f.sid, projectIdentity(f.cwd), Date.now(), Date.now()],
		);
		chmodSync(env.SUSPENDERS_CLAUDE_NATIVE_BIN, 0o700);
		const root = realpathSync(join(f.home, "repo"));
		mkdirSync(join(root, ".fleet"), { recursive: true });
		const log = join(root, ".fleet", `lane-${f.sid}.log`);
		const settings =
			mode === "watcher"
				? join(root, ".fleet", `lane-settings-${f.sid}.json`)
				: join(f.cwd, ".fleet", `restart-settings-${f.sid}.json`);
		writeFileSync(settings, "{}", { mode: 0o600 });
		if (mode === "watcher") {
			mkdirSync(wakeDir, { recursive: true });
			// Actual live competing watcher owner: never steal its lock.
			writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
				mode: 0o600,
			});
		}
		runtime = Bun.spawn(
			[
				process.execPath,
				join(f.hooks, "bin/claude-runtime.ts"),
				"-p",
				"original",
				"--settings",
				settings,
				"--append-system-prompt",
				f.sid,
			],
			{ cwd: f.cwd, env, stdout: "pipe", stderr: "pipe" },
		);
		const reader = (async () => {
			let pending = "";
			for await (const chunk of runtime.stdout) {
				pending += new TextDecoder().decode(chunk);
				let end = pending.indexOf("\n");
				while (end >= 0) {
					const line = pending.slice(0, end);
					appendFileSync(log, `${line}\n`);
					pending = pending.slice(end + 1);
					frames.push(JSON.parse(line));
					end = pending.indexOf("\n");
				}
			}
		})();
		const wait = async (predicate: () => boolean) => {
			for (let i = 0; i < 150; i++) {
				if (predicate()) return;
				await Bun.sleep(20);
			}
			throw Error(
				`native boundary missing: ${JSON.stringify(frames.slice(-4))}`,
			);
		};
		await wait(() => frames.some((frame) => frame.subtype === "init"));
		if (mode === "watcher") unlinkSync(lock);
		const registry = join(f.home, "repo", ".fleet");
		mkdirSync(registry, { recursive: true });
		writeFileSync(
			join(registry, "lanes.json"),
			JSON.stringify([
				{
					sid: f.sid,
					item: f.id,
					worktree: f.cwd,
					pid: runtime.pid,
					launchedAt: Date.now(),
				},
			]),
		);
		expect(await subscriber("attachSubscribe")).toBe("true\n");
		if (mode === "watcher")
			await call([
				"-e",
				`const {openStore,projectIdentity}=await import(${JSON.stringify(join(f.hooks, "lib/govdb.ts"))});const {acquireLaunchLease}=await import(${JSON.stringify(join(f.hooks, "../scripts/lib/launch-preflight.ts"))});const {reserveLaunchIntent,registerLaunch}=await import(${JSON.stringify(join(f.hooks, "../scripts/lib/launch-fencing.ts"))});const d=openStore(),project=projectIdentity(),sid=${JSON.stringify(f.sid)},item=${JSON.stringify(f.id)},nonce="fixture-launch";if(!acquireLaunchLease(d,project,sid,nonce))throw Error("lease");const claim=d.query("SELECT updated_at FROM work_items WHERE project=? AND id=?").get(project,item);const intent=reserveLaunchIntent(d,{project,item,sid,nonce,revision:claim.updated_at,executor:${JSON.stringify(join(f.hooks, "bin/claude-runtime.ts"))}},3);registerLaunch(d,intent,${runtime.pid});d.close();`,
			]);
		await Bun.sleep(60);
		if (mode === "claim") {
			await call([
				join(f.hooks, "bin/work.ts"),
				"release",
				f.id,
				"--as",
				f.sid,
			]);
			expect(await subscriber("subscribeLive")).toBe("true\n");
			// Simulate an independently lost subscriber: successful retake must
			// repair attachment without restarting or adopting a native process.
			await subscriber("reapSubscribe");
			await call([join(f.hooks, "bin/work.ts"), "take", f.id, "--as", f.sid]);
			expect(await subscriber("subscribeLive")).toBe("true\n");
		}
		await coord("pause", f.sid, "--reason", "fixture deployment boundary");
		await wait(() =>
			frames.some(
				(frame) =>
					frame.type === "fleet.claude.pause" && frame.state === "paused",
			),
		);
		expect(pausedNativeBoundary(frames, f.sha)).toBe(true);
		expect(
			frames.some(
				(frame) =>
					frame.type === "fleet.claude.delivery" &&
					frame.state === "interrupted-and-injected",
			),
		).toBe(true);
		// The native fixture acts, then acknowledges its own delivered event.
		expect(await coord("inbox")).not.toContain("pause_requested");
		expect(runtime.exitCode).toBeNull();
		if (mode === "watcher" && process.platform === "darwin") {
			await subscriber("reapSubscribe");
			await coord(
				"pause",
				f.sid,
				"--reason",
				"lost old watcher operator reconciliation",
			);
			const operation = join(f.hooks, "../scripts/lib/pause-reconcile.ts");
			const evidence = join(f.home, "pause-evidence.json");
			await call([
				"-e",
				`const {reconcilePause}=await import(${JSON.stringify(operation)});reconcilePause(${JSON.stringify(root)},${JSON.stringify(f.id)},${JSON.stringify(evidence)},false);reconcilePause(${JSON.stringify(root)},${JSON.stringify(f.id)},${JSON.stringify(evidence)},true);`,
			]);
			expect(await coord("fact", "get", `lane.${f.sid}.state`)).toStartWith(
				"PAUSED ",
			);
			expect(await coord("inbox")).toContain("pause_requested");
			await subscriber("attachSubscribe");
		}
		await coord("resume", f.sid, "--onto", f.sha);
		expect(await runtime.exited).toBe(0);
		await reader;
		const dead = await call([
			"-e",
			`const {openStore}=await import(${JSON.stringify(join(f.hooks, "lib/govdb-store.ts"))}); const {reapIfIdle}=await import(${JSON.stringify(join(f.hooks, "lib/subscribe-attach.ts"))});const db=openStore();db.query("UPDATE sessions SET state='CLOSED' WHERE sid=?").run(${JSON.stringify(f.sid)});db.query("UPDATE work_items SET state='READY',owner_sid=NULL WHERE id=?").run(${JSON.stringify(f.id)});console.log(reapIfIdle(db,${JSON.stringify(f.sid)}));`,
		]);
		expect(dead).toBe("true\n");
		expect(await subscriber("subscribeLive")).toBe("false\n");
	} finally {
		runtime?.kill();
		await subscriber("reapSubscribe").catch(() => {});
		server.kill();
		await server.exited;
		rmSync(f.home, { recursive: true, force: true });
	}
}

test("managed release and retake retain subscription and deliver an accepted pause", () =>
	exerciseSubscriberLifecycle("claim"));
test("managed watcher re-arms after real lock contention and delivers queued pause", () =>
	exerciseSubscriberLifecycle("watcher"));
