import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { steerCodexDirectEvent } from "../hooks/lib/codex-steer.ts";
import { codexAdapter } from "../hooks/lib/executors/codex.ts";
import { executorLaunch } from "../scripts/lib/lane.ts";

const wrapperPath = join(
	import.meta.dir,
	"..",
	"hooks",
	"bin",
	"codex-managed-turn.ts",
);
const fakePath = join(import.meta.dir, "fixtures", "codex-app-server-fake.ts");
const socketFixture = join(
	import.meta.dir,
	"fixtures",
	"codex-app-server-socket.ts",
);
const serverPath = join(
	import.meta.dir,
	"..",
	"hooks",
	"bin",
	"store-server.ts",
);
const home = mkdtempSync(join(tmpdir(), "codex-managed-turn-"));
const processes: ReturnType<typeof Bun.spawn>[] = [];
const THREAD = "019b0ba5-4c7e-7d51-99fa-85704ad78b99";
const TURN = "turn-1";

afterAll(() => {
	for (const child of processes) child.kill();
	rmSync(home, { recursive: true, force: true });
});

async function rpc(
	url: string,
	mode: string,
	sql: string,
	params: unknown[],
): Promise<{ rows?: Array<Record<string, unknown>> }> {
	const response = await fetch(`${url}/rpc`, {
		method: "POST",
		body: JSON.stringify({ mode, sql, params }),
	});
	expect(response.ok).toBe(true);
	return response.json();
}

async function startStore(): Promise<string> {
	const reservation = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = reservation.port;
	reservation.stop(true);
	const url = `http://127.0.0.1:${port}`;
	const server = Bun.spawn(["bun", serverPath, "--port", String(port)], {
		env: { ...process.env, HOME: home, NO_COLOR: "1" },
		stdout: "ignore",
		stderr: "pipe",
	});
	processes.push(server);
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) return url;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("store server did not start");
}

test("codex adapter rides the managed runtime seam", () => {
	const launch = executorLaunch(codexAdapter, "/usr/local/bin/codex");
	expect(launch.bin.endsWith("codex-managed-turn.ts")).toBe(true);
	expect(launch.env.SUSPENDERS_CODEX_NATIVE_BIN).toBe("/usr/local/bin/codex");
});

test("the per-lane steer socket carries the subscriber's face", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-sock-"));
	const sock = `${dir}/steer.sock`;
	const fixture = Bun.spawn([process.execPath, socketFixture, sock], {
		stdout: "ignore",
		stderr: "pipe",
	});
	processes.push(fixture);
	try {
		for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(20);
		expect(existsSync(sock)).toBe(true);
		const delivered = await steerCodexDirectEvent(
			{
				id: 7,
				source: "fleet-test",
				kind: "consult",
				target: THREAD,
				payload: JSON.stringify({ cid: "C1", question: "active?" }),
			},
			{ sock },
		);
		expect(delivered).toEqual({ state: "steered", turnId: "turn-live" });
	} finally {
		fixture.kill();
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);

test("managed turn hosts the mission, banks facts, and stays steerable", async () => {
	const url = await startStore();
	const wt = mkdtempSync(join(tmpdir(), "codex-mt-run-"));
	const sock = `${wt}/.fleet/codex-appserver.sock`;
	const lane = Bun.spawn(
		[
			process.execPath,
			wrapperPath,
			"exec",
			"--sandbox",
			"danger-full-access",
			"Reply with exactly: mission-ok",
		],
		{
			cwd: wt,
			env: {
				...process.env,
				HOME: home,
				GOVERNOR_STORE_URL: url,
				SUSPENDERS_CODEX_NATIVE_BIN: fakePath,
				SUSPENDERS_SID: "managed-turn-lane",
				FAKE_HOLD_MS: "2500",
				NO_COLOR: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	processes.push(lane);
	try {
		for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(20);
		expect(existsSync(sock)).toBe(true);
		// Mid-turn steering through the wrapper's socket, exactly what the
		// coord subscriber does when a direct event lands.
		const steered = await steerCodexDirectEvent(
			{
				id: 9,
				source: "fleet-test",
				kind: "consult",
				target: THREAD,
				payload: JSON.stringify({ cid: "C9", question: "mid-turn?" }),
			},
			{ sock },
		);
		expect(steered).toEqual({ state: "steered", turnId: TURN });
		const code = await lane.exited;
		expect(code).toBe(0);
		const out = await new Response(lane.stdout).text();
		expect(out).toContain('"fleet.codex.managed":"started"');
		expect(out).toContain('"fleet.codex.turn":"completed"');
		const threadRow = await rpc(
			url,
			"all",
			"SELECT value FROM facts WHERE key = ?",
			["codex.thread.managed-turn-lane"],
		);
		const sockRow = await rpc(
			url,
			"all",
			"SELECT value FROM facts WHERE key = ?",
			["codex.sock.managed-turn-lane"],
		);
		expect(threadRow.rows?.[0]?.value).toBe(THREAD);
		// The wrapper banks process.cwd(), which macOS realpaths through the
		// /var → /private/var symlink; compare the resolved expectation.
		expect(sockRow.rows?.[0]?.value).toBe(
			`${realpathSync(wt)}/.fleet/codex-appserver.sock`,
		);
	} finally {
		lane.kill();
		rmSync(wt, { recursive: true, force: true });
	}
}, 30_000);

test("managed-init failure falls back to the verbatim exec argv", async () => {
	const wt = mkdtempSync(join(tmpdir(), "codex-mt-fb-"));
	const lane = Bun.spawn(
		[
			process.execPath,
			wrapperPath,
			"exec",
			"--sandbox",
			"danger-full-access",
			"fallback probe",
		],
		{
			cwd: wt,
			env: {
				...process.env,
				HOME: home,
				SUSPENDERS_CODEX_NATIVE_BIN: fakePath,
				SUSPENDERS_SID: "managed-turn-fb",
				FAKE_FAIL: "1",
				NO_COLOR: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	processes.push(lane);
	try {
		const code = await lane.exited;
		expect(code).toBe(0);
		const out = await new Response(lane.stdout).text();
		expect(out).toContain("exec-fallback-ran");
		expect(out).toContain('"fleet.codex.managed":"fallback"');
	} finally {
		lane.kill();
		rmSync(wt, { recursive: true, force: true });
	}
}, 20_000);
