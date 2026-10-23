import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";
import { projectIdentity } from "../hooks/lib/govdb-project.ts";
import { pausedNativeBoundary } from "../hooks/lib/claude-restart.ts";

test("managed release and retake retain subscription and deliver an accepted pause", async () => {
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
	};
	const frames: Record<string, unknown>[] = [];
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
		const settings = join(f.cwd, ".fleet", `restart-settings-${f.sid}.json`);
		writeFileSync(settings, "{}", { mode: 0o600 });
		runtime = Bun.spawn(
			[
				process.execPath,
				join(f.hooks, "bin/claude-runtime.ts"),
				"-p",
				"original",
				"--settings",
				settings,
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
		await Bun.sleep(60);
		await call([join(f.hooks, "bin/work.ts"), "release", f.id, "--as", f.sid]);
		expect(await subscriber("subscribeLive")).toBe("true\n");
		// Simulate an independently lost subscriber: successful retake must
		// repair attachment without restarting or adopting a native process.
		await subscriber("reapSubscribe");
		await call([join(f.hooks, "bin/work.ts"), "take", f.id, "--as", f.sid]);
		expect(await subscriber("subscribeLive")).toBe("true\n");
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
});
