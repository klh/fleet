import { expect, test } from "./pw";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForClaudeWake } from "../hooks/lib/executors/claude-wake.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

const home = mkdtempSync(join(tmpdir(), "claude-direct-subscribe-"));
const processes: ReturnType<typeof Bun.spawn>[] = [];
test.afterAll(() => {
	for (const process of processes) process.kill();
	rmSync(home, { recursive: true, force: true });
});

test("the real subscriber signals direct Claude events and leaves ordinary broadcasts queued", async () => {
	const reserve = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = reserve.port;
	reserve.stop(true);
	const url = `http://127.0.0.1:${port}`;
	const hooks = join(import.meta.dir, "..", "hooks");
	const server = Bun.spawn(
		["bun", join(hooks, "bin/store-server.ts"), "--port", String(port)],
		{
			env: { ...process.env, HOME: home },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	processes.push(server);
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) break;
		} catch {}
		if (i === 49) throw new Error("store server did not start");
		await Bun.sleep(50);
	}
	async function rpc(sql: string, params: unknown[]) {
		const response = await fetch(`${url}/rpc`, {
			method: "POST",
			body: JSON.stringify({ mode: "run", sql, params }),
		});
		expect(response.ok).toBe(true);
		return response.json();
	}
	const sid = "claude-real-subscriber";
	await rpc(
		"INSERT INTO sessions (sid, project, started_at, hb, state, tags) VALUES (?, ?, ?, ?, 'RUNNING', '{}')",
		[sid, projectIdentity(), Date.now(), Date.now()],
	);
	const subscriber = Bun.spawn(
		["bun", join(hooks, "bin/coord.ts"), "subscribe", "--as", sid],
		{
			env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: url },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	processes.push(subscriber);
	await Bun.sleep(150);
	async function emit(kind: string, target = sid) {
		await rpc(
			"INSERT INTO events (ts, source, kind, payload, target) VALUES (?, 'peer', ?, ?, ?)",
			[
				Date.now(),
				kind,
				JSON.stringify({ note: `urgent upstream ${kind}` }),
				target,
			],
		);
	}
	for (const kind of ["NOTE", "consult", "consult.answer"]) {
		const wake = waitForClaudeWake(sid, { home, timeoutMs: 1000 });
		await emit(kind);
		expect(await wake).toContain(`urgent upstream ${kind}`);
	}
	const quiet = waitForClaudeWake(sid, { home, timeoutMs: 50 });
	await emit("BROADCAST");
	await emit("NOTE", "other-session");
	expect(await quiet).toBeNull();
});
