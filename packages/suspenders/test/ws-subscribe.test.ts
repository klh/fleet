// test/ws-subscribe.test.ts — W303/W305: the store server's WebSocket
// /subscribe channel. Covers the two things this segment landed:
//   1. push still works: an HTTP /rpc insert is broadcast to a matching
//      subscriber (the original W303 contract, unchanged).
//   2. the channel is now bidirectional (W305): a subscribed socket can send
//      the exact {mode,sql,params} body /rpc accepts and get a correlated
//      {id, ...result} reply over the SAME connection, and malformed input
//      gets an {err} reply rather than closing the socket.
// Runs store-server.ts as a real subprocess on an ephemeral port — no mocks,
// the actual Bun.serve websocket wiring is what's under test.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb-project.ts";

const SERVER = join(import.meta.dir, "..", "hooks", "bin", "store-server.ts");
const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-ws-subscribe-test-"));

const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
});

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

const startServer = async (port: number): Promise<string> => {
	const p = Bun.spawn(["bun", SERVER, "--port", String(port)], {
		env: { ...process.env, HOME: home, NO_COLOR: "1" },
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`${url}/health`);
			if (r.ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("store server did not come up");
};

// a real FIFO queue, not two racing {once:true} listeners — every listener
// on a socket fires for EVERY message, so two pending reads would both
// resolve off the first frame and starve the second forever. One standing
// listener buffers frames; each call drains the buffer or parks a resolver
// for the next arrival, in order.
function messageQueue(ws: WebSocket): () => Promise<Record<string, unknown>> {
	const buffered: Record<string, unknown>[] = [];
	const waiting: ((m: Record<string, unknown>) => void)[] = [];
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(String(e.data));
		const w = waiting.shift();
		if (w) w(m);
		else buffered.push(m);
	});
	return () =>
		new Promise((resolve) => {
			const m = buffered.shift();
			if (m) resolve(m);
			else waiting.push(resolve);
		});
}

async function cli(
	url: string,
	args: string[],
): Promise<{ code: number; out: string; err: string }> {
	const process = Bun.spawn(["bun", COORD, ...args], {
		env: {
			...globalThis.process.env,
			HOME: home,
			GOVERNOR_STORE_URL: url,
			SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
			NO_COLOR: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { out, err, code };
}

describe("WS /subscribe (W303 push + W305 bidirectional RPC)", () => {
	test("consult @name and reply travel through the store to both WS inboxes", async () => {
		const url = await startServer(await freePort());
		const expert = "ws-e2e-expert";
		const asker = "ws-e2e-asker";
		for (const [sid, tags] of [
			[expert, JSON.stringify({ name: "Fleet" })],
			[asker, "{}"],
		]) {
			const response = await fetch(`${url}/rpc`, {
				method: "POST",
				body: JSON.stringify({
					mode: "run",
					sql: "INSERT INTO sessions (sid, project, started_at, hb, state, tags) VALUES (?, ?, ?, ?, 'RUNNING', ?)",
					params: [sid, projectIdentity(), Date.now(), Date.now(), tags],
				}),
			});
			expect(response.ok).toBe(true);
		}
		const expertWs = new WebSocket(
			`${url.replace(/^http/, "ws")}/subscribe?as=${expert}`,
		);
		const askerWs = new WebSocket(
			`${url.replace(/^http/, "ws")}/subscribe?as=${asker}`,
		);
		await Promise.all(
			[expertWs, askerWs].map(
				(ws) =>
					new Promise<void>((resolve) =>
						ws.addEventListener("open", () => resolve()),
					),
			),
		);
		const expertNext = messageQueue(expertWs);
		const askerNext = messageQueue(askerWs);
		try {
			const opened = await cli(url, [
				"consult",
				"@Fleet",
				"How does the subscriber carry consults?",
				"--no-kb",
				"--as",
				asker,
			]);
			expect(opened.code).toBe(0);
			const cid = opened.out.match(/C\d+/)?.[0] ?? "";
			expect(cid).not.toBe("");
			const received = await expertNext();
			expect(received.kind).toBe("consult");
			expect(received.target).toBe(expert);
			expect(JSON.parse(String(received.payload)).consult).toBe(cid);
			const replied = await cli(url, [
				"consult-reply",
				cid,
				"The store pushes the directed event to the subscriber.",
				"--as",
				expert,
			]);
			expect(replied.code).toBe(0);
			const answer = await askerNext();
			expect(answer.kind).toBe("consult.answer");
			expect(answer.target).toBe(asker);
			expect(JSON.parse(String(answer.payload)).consult).toBe(cid);
		} finally {
			expertWs.close();
			askerWs.close();
		}
	});
	test("HTTP insert is pushed to a matching subscriber", async () => {
		const url = await startServer(await freePort());
		const wsUrl = `${url.replace(/^http/, "ws")}/subscribe?as=lane-ws1`;
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve) =>
			ws.addEventListener("open", () => resolve()),
		);
		const next = messageQueue(ws);
		const pushed = next();
		const r = await fetch(`${url}/rpc`, {
			method: "POST",
			body: JSON.stringify({
				mode: "run",
				sql: "INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
				params: [Date.now(), "test", "checkpoint", null, "{}", "lane-ws1"],
			}),
		});
		expect(r.ok).toBe(true);
		const row = await pushed;
		expect(row.kind).toBe("checkpoint");
		expect(row.target).toBe("lane-ws1");
		ws.close();
	});

	test("a subscribed socket can send its own RPC and get a correlated reply", async () => {
		const url = await startServer(await freePort());
		const wsUrl = `${url.replace(/^http/, "ws")}/subscribe?as=lane-ws2`;
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve) =>
			ws.addEventListener("open", () => resolve()),
		);
		const next = messageQueue(ws);
		// this socket's own write arrives twice: the correlated RPC reply AND
		// the broadcast push of the row it just inserted (target = itself).
		const first = next();
		ws.send(
			JSON.stringify({
				id: "req-1",
				mode: "run",
				sql: "INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
				params: [Date.now(), "lane-ws2", "self.emit", null, "{}", "lane-ws2"],
			}),
		);
		const second = next();
		const a = await first;
		const b = await second;
		const reply = [a, b].find((m) => m.id === "req-1");
		const broadcast = [a, b].find((m) => m.kind === "self.emit");
		expect(reply).toBeTruthy();
		// The governor delta trigger may contribute a second SQLite change.
		expect(Number(reply?.changes)).toBeGreaterThanOrEqual(1);
		expect(typeof reply?.lastInsertRowid).toBe("number");
		expect(broadcast).toBeTruthy();
		expect(broadcast?.target).toBe("lane-ws2");
		ws.close();
	});

	test("malformed input over the socket gets {err}, not a dropped connection", async () => {
		const url = await startServer(await freePort());
		const wsUrl = `${url.replace(/^http/, "ws")}/subscribe?as=lane-ws3`;
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve) =>
			ws.addEventListener("open", () => resolve()),
		);
		const next = messageQueue(ws);
		const badJson = next();
		ws.send("not json");
		expect((await badJson).err).toBe("invalid JSON");
		const badMode = next();
		ws.send(
			JSON.stringify({ id: "req-2", mode: "nope", sql: "x", params: [] }),
		);
		expect((await badMode).id).toBe("req-2");
		expect((await badMode).err).toBe("bad request");
		// socket must still be open and answer a well-formed request after two
		// bad ones — the point of replying instead of closing.
		const good = next();
		ws.send(
			JSON.stringify({
				id: "req-3",
				mode: "get",
				sql: "SELECT 1 AS n",
				params: [],
			}),
		);
		const row = (await good).row as { n: number } | null;
		expect(row?.n).toBe(1);
		ws.close();
	});
});
