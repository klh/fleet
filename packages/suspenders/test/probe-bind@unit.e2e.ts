import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { freePort, runCliAsync, scratchWorld, serveStub } from "@klh/test-kit";

const PROBE = join(import.meta.dir, "../deploy/healthcheck/probe.ts");
test("probe remains standalone outside workspace package resolution @unit", async () => {
	const world = scratchWorld();
	const upstream = serveStub(() => Response.json({ ok: true }));
	try {
		const standalone = join(world.repo, "probe.ts");
		await Bun.write(standalone, Bun.file(PROBE));
		const env = {
			...world.env,
			NODE_PATH: undefined,
			PORT: undefined,
			TARGET_URL: undefined,
		};
		const usage = await runCliAsync("--no-install", [standalone], {
			cwd: world.repo,
			env,
		});
		expect(usage.code, usage.err).toBe(2);
		expect(usage.out).toContain("usage: probe.ts");
		const poll = await runCliAsync(
			"--no-install",
			[standalone, "--target", upstream.url],
			{ cwd: world.repo, env },
		);
		expect(poll.code, poll.err).toBe(0);
		expect(JSON.parse(poll.out)).toMatchObject({ ok: true, status: 200 });
	} finally {
		try {
			upstream.close();
		} finally {
			world.clean();
		}
	}
});
test("probe rejects malformed and missing bind values before polling @unit", async () => {
	const upstream = serveStub(() => Response.json({ ok: true }));
	try {
		for (const flags of [
			["--bind", "not-an-ip"],
			["--bind", "999.1.1.1"],
			["--bind"],
			["--bind", "--timeout", "20"],
		]) {
			const result = await runCliAsync(PROBE, [
				"--target",
				upstream.url,
				...flags,
			]);
			expect(result.code).toBe(2);
			expect(result.err).toContain("--bind");
		}
		expect(upstream.requests).toHaveLength(0);
	} finally {
		upstream.close();
	}
});
for (const bind of [undefined, "0.0.0.0", "::1"]) {
	test(`probe listener binds ${bind ?? "loopback by default"} and serves a real verdict @unit`, async () => {
		const world = scratchWorld();
		const upstream = serveStub(() => Response.json({ ok: true }));
		try {
			const wrapper = join(world.repo, "capture-listener.ts");
			await Bun.write(
				wrapper,
				`
const serve = Bun.serve.bind(Bun);
Object.defineProperty(Bun, "serve", { value(options) {
  const server = serve(options);
  setTimeout(async () => {
    try {
      const host = options.hostname === "::1" ? "[::1]" : "127.0.0.1";
      const response = await fetch("http://" + host + ":" + server.port + "/healthz", { signal: AbortSignal.timeout(2000) });
      console.log(JSON.stringify({ bind: options.hostname, status: response.status, ok: (await response.json()).ok }));
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
    finally { server.stop(true); }
  }, 20);
  return server;
}});
`,
			);
			const args = [
				wrapper,
				PROBE,
				"--target",
				upstream.url,
				"--listen",
				String(await freePort()),
				"--every",
				"50",
				"--timeout",
				"200",
			];
			if (bind !== undefined) args.push("--bind", bind);
			const result = await runCliAsync("--preload", args, { env: world.env });
			expect(result.code, result.err).toBe(0);
			expect(
				JSON.parse(result.out.trim().split("\n").at(-1) ?? "null"),
			).toEqual({ bind: bind ?? "127.0.0.1", status: 200, ok: true });
		} finally {
			try {
				upstream.close();
			} finally {
				world.clean();
			}
		}
	});
}
