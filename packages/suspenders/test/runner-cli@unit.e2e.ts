import { expect, test } from "@playwright/test";
import { scratchWorld, runCli } from "@klh/test-kit";
import { join } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
const BIN = join(import.meta.dir, "../hooks/bin/coord.ts");

test("runner CLI carries only validated trace IDs from HTTP failures @unit", async () => {
	const world = scratchWorld();
	const keyFile = join(world.home, "runner.key");
	writeFileSync(keyFile, "fixture-key", { mode: 0o600 });
	const trace = crypto.randomUUID();
	let header = trace;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response("private provider error", {
				status: 503,
				headers: { "x-runner-trace-id": header },
			}),
	});
	try {
		for (const expected of [trace, undefined]) {
			header = expected ?? "private invalid trace";
			const child = Bun.spawn(
				[
					process.execPath,
					BIN,
					"runner",
					"health",
					"--ndjson",
					"--url",
					server.url.href,
					"--key-file",
					keyFile,
				],
				{ cwd: world.repo, env: world.env, stdout: "pipe", stderr: "pipe" },
			);
			const [out, err, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code).toBe(1);
			expect(JSON.parse(out)).toMatchObject({
				ok: false,
				error: "runner.http_503",
			});
			expect(JSON.parse(out).traceId).toBe(expected);
			expect(out + err).not.toContain("private");
		}
	} finally {
		await server.stop(true);
		world.clean();
	}
});

test("runner health rejects a FIFO credential without waiting for a writer @unit", async () => {
	const world = scratchWorld();
	const keyFile = join(world.home, "runner.fifo");
	try {
		expect(Bun.spawnSync(["mkfifo", "-m", "600", keyFile]).exitCode).toBe(0);
		const child = Bun.spawn(
			[process.execPath, BIN, "runner", "health", "--key-file", keyFile],
			{ cwd: world.repo, env: world.env, stderr: "pipe", stdout: "ignore" },
		);
		const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
		try {
			expect(await child.exited).toBe(1);
			expect(await new Response(child.stderr).text()).toContain(
				"runner.private_credential_required",
			);
		} finally {
			clearTimeout(deadline);
		}
	} finally {
		world.clean();
	}
});

test("runner help needs neither store nor a credential @unit", () => {
	const world = scratchWorld();
	try {
		world.env.GOVERNOR_STORE_URL = "http://127.0.0.1:1";
		const result = runCli(BIN, ["runner", "--help"], {
			cwd: world.repo,
			env: world.env,
		});
		expect(result.code, result.err).toBe(0);
		expect(result.out).toContain("--ndjson");
	} finally {
		world.clean();
	}
});

test("runner CLI uses private user key and emits actual NDJSON completion @unit", async () => {
	const world = scratchWorld();
	const keyFile = join(world.home, "runner.key");
	writeFileSync(keyFile, "fixture-key", { mode: 0o600 });
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			seen.push(request.headers.get("authorization") ?? "");
			return Response.json({
				runs: [{ runId: "fixture-run" }],
				nextCursor: null,
			});
		},
	});
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				BIN,
				"runner",
				"list",
				"--url",
				`http://127.0.0.1:${server.port}`,
				"--key-file",
				keyFile,
				"--ndjson",
			],
			{ cwd: world.repo, env: world.env, stdout: "pipe", stderr: "pipe" },
		);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, err).toBe(0);
		const rows = out
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows.at(-1)).toMatchObject({ type: "complete", ok: true });
		expect(seen).toEqual(["Bearer fixture-key"]);
		const probe = Bun.spawn(
			[
				process.execPath,
				BIN,
				"runner",
				"health",
				"--url",
				`http://127.0.0.1:${server.port}`,
				"--key-file",
				keyFile,
				"--json",
			],
			{ cwd: world.repo, env: world.env, stdout: "pipe", stderr: "pipe" },
		);
		const [probeOut, probeErr, probeCode] = await Promise.all([
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
			probe.exited,
		]);
		expect(probeCode, probeErr).toBe(0);
		expect(JSON.parse(probeOut)).toEqual({ control: "ready" });
		chmodSync(keyFile, 0o644);
		const denied = runCli(
			BIN,
			[
				"runner",
				"list",
				"--url",
				`http://127.0.0.1:${server.port}`,
				"--key-file",
				keyFile,
				"--ndjson",
			],
			{ cwd: world.repo, env: world.env },
		);
		expect(denied.code).toBe(1);
		expect(JSON.parse(denied.out)).toMatchObject({
			type: "complete",
			ok: false,
		});
		expect(denied.err).toContain("runner.private_credential_required");
		expect(denied.err).not.toContain("fixture-key");
		expect(seen).toEqual(["Bearer fixture-key", "Bearer fixture-key"]);
	} finally {
		server.stop(true);
		world.clean();
	}
});
