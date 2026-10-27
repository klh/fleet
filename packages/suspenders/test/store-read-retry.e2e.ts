// test/store-read-retry.test.ts — W716: HttpGovernorStore read paths
// backoff-retry the store-server's serialized-tx refusal ("a transaction
// is open — retry") instead of crashing the CLI. A stub server refuses
// reads N times before answering; the client runs in spawned children
// (W362: an in-process stub cannot answer spawnSync round trips).
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-w716-read-retry-"));
const repo = mkdtempSync(join(tmpdir(), "suspenders-w716-read-retry-repo-"));
Bun.spawnSync(["git", "init", "-q", repo]);

const BUSY = "a transaction is open — retry";

const servers: Bun.Server[] = [];
test.afterAll(() => {
	for (const s of servers) s.stop(true);
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

// refuse(body) → true counts a hit and answers the busy refusal; anything
// else gets the default success shape for its mode.
const makeStub = (
	refuse: (body: { mode: string; sql: string }) => boolean,
	receipt: Record<string, unknown> = {},
) => {
	let hits = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			if (new URL(req.url).pathname === "/probe")
				return Response.json({ ok: true });
			const body = (await req.json()) as { mode: string; sql: string };
			if (refuse(body)) {
				hits++;
				return Response.json({ err: BUSY, ...receipt });
			}
			if (body.mode === "get") return Response.json({ row: { one: 1 } });
			if (body.mode === "all") return Response.json({ rows: [] });
			if (body.mode === "run")
				return Response.json({ changes: 0, lastInsertRowid: 0 });
			return Response.json({ ok: true });
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, hits: () => hits };
};

const runChild = async (
	code: string,
	url: string,
): Promise<{ code: number; out: string; err: string }> => {
	// the child's curl has no retry — a refused connect reads as a dead
	// store and crashes it at open; hold until the stub actually accepts
	for (let i = 0; i < 50; i++) {
		try {
			await fetch(`${url}/probe`);
			break;
		} catch {}
		await Bun.sleep(20);
	}
	const p = Bun.spawn(["bun", "-e", code], {
		cwd: repo,
		env: {
			...process.env,
			HOME: home,
			NO_COLOR: "1",
			GOVERNOR_STORE_URL: url,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	await p.exited;
	return {
		code: p.exitCode ?? 1,
		out: await new Response(p.stdout).text(),
		err: await new Response(p.stderr).text(),
	};
};

const parseOut = (out: string, err: string): unknown => {
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(
			`unparseable child stdout: ${JSON.stringify(out)} (stderr: ${JSON.stringify(err)})`,
		);
	}
};

const childProbe = (stmt: string, url: string) => `
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const s = new HttpGovernorStore(${JSON.stringify(url)}, null);
try {
	${stmt}
} catch (e) {
	console.log(JSON.stringify({ busy: String(e).includes(${JSON.stringify(BUSY)}) }));
}
`;

test.describe("W716 — HttpGovernorStore read retry on serialized-tx refusal", () => {
	const isProbe = (sql: string) => sql === "SELECT 1";
	const isRead = (b: { mode: string; sql: string }) =>
		(b.mode === "get" || b.mode === "all") && !isProbe(b.sql);

	test("read retried to success after two refusals", async () => {
		let refused = 0;
		const stub = makeStub((b) => {
			if (isRead(b) && refused < 2) {
				refused++;
				return true;
			}
			return false;
		});
		const r = await runChild(
			childProbe(
				`console.log(JSON.stringify({ row: s.query("SELECT 42 AS v").get() }));`,
				stub.url,
			),
			stub.url,
		);
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ row: { one: 1 } });
		expect(stub.hits()).toBe(2);
	});

	test("refusal surfaces after exactly three attempts", async () => {
		const stub = makeStub(isRead);
		const r = await runChild(
			childProbe(`s.query("SELECT 42 AS v").get();`, stub.url),
			stub.url,
		);
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ busy: true });
		expect(stub.hits()).toBe(3);
	});

	test("writes surface the refusal immediately (no retry)", async () => {
		const stub = makeStub((b) => b.mode === "run");
		const r = await runChild(
			childProbe(
				`s.run("INSERT INTO events(kind) VALUES ('w716t')");`,
				stub.url,
			),
			stub.url,
		);
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ busy: true });
		expect(stub.hits()).toBe(1);
	});
	test("writes never replay when a busy-looking receipt does not prove nonexecution", async () => {
		const stub = makeStub((body) => body.mode === "run", {
			code: "store_tx_busy",
			executed: true,
		});
		const result = await runChild(
			childProbe(
				`s.run("INSERT INTO events(kind) VALUES ('ambiguous')");`,
				stub.url,
			),
			stub.url,
		);
		expect(result.code).toBe(0);
		expect(parseOut(result.out, result.err)).toEqual({ busy: true });
		expect(stub.hits()).toBe(1);
	});
});
