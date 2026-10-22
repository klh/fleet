import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const commands = [
	["coord", "--help"],
	["coord", "bootstrap", "--help"],
	["coord", "consult", "--help"],
	["work", "--help"],
	["work", "done", "--help"],
	["auth", "--help"],
];
async function help(base: string, cwd: string, args: string[]) {
	const child = Bun.spawn(
		[
			process.execPath,
			join(ROOT, "packages/suspenders/hooks/bin", `${args[0]}.ts`),
			...args.slice(1),
		],
		{
			cwd,
			env: { ...process.env, GOVERNOR_STORE_URL: base },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const result = await Promise.race([
		child.exited.then((code) => ({ code, timedOut: false })),
		new Promise<{ code: null; timedOut: boolean }>((done) => {
			timer = setTimeout(() => {
				child.kill();
				done({ code: null, timedOut: true });
			}, 1500);
		}),
	]);
	clearTimeout(timer);
	await child.exited;
	return {
		...result,
		output: await new Response(child.stdout).text(),
		error: await new Response(child.stderr).text(),
	};
}

test("help is stateless while the configured store repeatedly refuses admission", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "fleet-help-busy-"));
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const body = (await req.json()) as { sql: string };
			calls.push(body.sql);
			return Response.json({
				err: "a transaction is open",
				code: "store_tx_busy",
				executed: false,
			});
		},
	});
	try {
		for (const args of commands) {
			const result = await help(`http://127.0.0.1:${server.port}`, cwd, args);
			expect({
				command: args.join(" "),
				code: result.code,
				timedOut: result.timedOut,
				calls,
			}).toEqual({
				command: args.join(" "),
				code: 0,
				timedOut: false,
				calls: [],
			});
			expect(result.output).toContain(args.length === 2 ? args[0] : "usage:");
		}
	} finally {
		server.stop(true);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("help remains available when the configured store is unreachable", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "fleet-help-unavailable-"));
	const server = Bun.serve({ port: 0, fetch: () => new Response() });
	const base = `http://127.0.0.1:${server.port}`;
	server.stop(true);
	try {
		for (const args of commands) {
			const result = await help(base, cwd, args);
			expect({
				command: args.join(" "),
				code: result.code,
				timedOut: result.timedOut,
			}).toEqual({ command: args.join(" "), code: 0, timedOut: false });
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a stateful verb still opens and queries the canonical HTTP store", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "fleet-help-stateful-"));
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const body = (await req.json()) as { mode: string; sql: string };
			calls.push(body.sql);
			return Response.json(
				body.mode === "all" ? { rows: [] } : { row: { one: 1 } },
			);
		},
	});
	try {
		const result = await help(`http://127.0.0.1:${server.port}`, cwd, [
			"coord",
			"poll",
		]);
		expect(result.code).toBe(0);
		expect(calls[0]).toBe("SELECT 1");
		expect(calls.some((sql) => sql.includes("FROM events"))).toBe(true);
	} finally {
		server.stop(true);
		rmSync(cwd, { recursive: true, force: true });
	}
});
