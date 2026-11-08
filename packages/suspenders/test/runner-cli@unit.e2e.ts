import { expect, test } from "@playwright/test";
import { scratchWorld, runCli } from "@klh/test-kit";
import { join } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
const BIN = join(import.meta.dir, "../hooks/bin/coord.ts");

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
		expect(seen).toHaveLength(1);
	} finally {
		server.stop(true);
		world.clean();
	}
});
