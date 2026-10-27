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
import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

const SERVER = join(import.meta.dir, "..", "hooks", "bin", "store-server.ts");
const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-ws-subscribe-test-"));

const procs: ReturnType<typeof Bun.spawn>[] = [];
test.afterAll(() => {
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

test.describe("WS /subscribe (W303 push + W305 bidirectional RPC)", () => {
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
	test("failed recipient discovery cannot masquerade as a broadcast consult; exact SID retries deliver", async () => {
		const url = await startServer(await freePort());
		const expert = "discovery-expert";
		const asker = "discovery-asker";
		const rpc = async (mode: string, sql: string, params: unknown[] = []) =>
			(
				await fetch(`${url}/rpc`, {
					method: "POST",
					body: JSON.stringify({ mode, sql, params }),
				})
			).json();
		for (const sid of [expert, asker])
			await rpc(
				"run",
				"INSERT INTO sessions (sid,project,started_at,hb,state,tags) VALUES (?,?,?,?,'RUNNING','{}')",
				[sid, projectIdentity(), Date.now(), Date.now()],
			);
		await rpc(
			"run",
			"INSERT INTO claims(sid,scope,intent,hot,ts) VALUES (?,'fixture','review questions',0,?)",
			[expert, Date.now()],
		);
		await rpc(
			"run",
			"INSERT INTO facts(key,value,source,ts) VALUES ('integration.head',?,'fixture',?)",
			["1234567890123456789012345678901234567890", Date.now()],
		);
		const ws = new WebSocket(
			`${url.replace(/^http/, "ws")}/subscribe?as=${expert}`,
		);
		await new Promise<void>((resolve) =>
			ws.addEventListener("open", () => resolve()),
		);
		const next = messageQueue(ws);
		try {
			const failed = await cli(url, [
				"consult",
				"@missing-head",
				"Please adjudicate the work",
				"--no-kb",
				"--as",
				asker,
			]);
			expect(failed.code).not.toBe(0);
			expect(failed.err).toContain("coord fleet --json");
			expect(failed.err).toContain("Do not substitute a broadcast");
			expect(
				(
					await rpc(
						"get",
						"SELECT COUNT(*) AS n FROM consults WHERE asker_sid = ?",
						[asker],
					)
				).row.n,
			).toBe(0);
			expect(
				(
					await rpc(
						"get",
						"SELECT COUNT(*) AS n FROM direct_message_receipts r JOIN events e ON e.id = r.event_id WHERE e.source = ?",
						[asker],
					)
				).row.n,
			).toBe(0);
			const broadcast = await cli(url, [
				"emit",
				"BROADCAST",
				"--note",
				"@missing-head adjudication request",
				"--as",
				asker,
			]);
			expect(broadcast.code).toBe(0);
			expect(broadcast.out).toContain("BROADCAST event queued");
			expect(broadcast.out).toContain("target=none; no consult opened");
			expect(broadcast.out).toContain("Inline @mentions do not route");
			const notice = await next();
			expect(notice.kind).toBe("BROADCAST");
			expect(notice.target).toBeNull();
			expect(
				(
					await rpc(
						"get",
						"SELECT COUNT(*) AS n FROM consults WHERE asker_sid = ?",
						[asker],
					)
				).row.n,
			).toBe(0);
			expect(
				(
					await rpc(
						"get",
						"SELECT COUNT(*) AS n FROM direct_message_receipts r JOIN events e ON e.id = r.event_id WHERE e.source = ?",
						[asker],
					)
				).row.n,
			).toBe(0);
			const fleet = await cli(url, ["fleet"]);
			expect(fleet.out).toContain("HEAD 1234567");
			expect(fleet.out).not.toContain("@1234567");
			const listed = [...fleet.out.matchAll(/\[sid=([^\]]+)\]/g)].map(
				(match) => match[1],
			);
			expect(listed).toContain(asker);
			const copied = listed.find((sid) => sid === expert);
			expect(copied).toBe(expert);
			const opened = await cli(url, [
				"consult",
				String(copied),
				"Please adjudicate the work",
				"--no-kb",
				"--as",
				asker,
			]);
			expect(opened.code).toBe(0);
			const question = await next();
			expect(question.kind).toBe("consult");
			expect(question.target).toBe(expert);
			expect(JSON.parse(String(question.payload)).consult).toMatch(/^C\d+$/);
			expect(
				(
					await rpc(
						"get",
						"SELECT expert_sid,state FROM consults WHERE asker_sid = ?",
						[asker],
					)
				).row,
			).toMatchObject({ expert_sid: expert, state: "OPEN" });
			expect(
				(
					await rpc(
						"get",
						"SELECT r.sid FROM direct_message_receipts r JOIN events e ON e.id = r.event_id WHERE e.source = ?",
						[asker],
					)
				).row.sid,
			).toBe(expert);
		} finally {
			ws.close();
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

	test.each(["http", "ws"])(
		"transactional events publish only after commit through %s",
		async (transport) => {
			const url = await startServer(await freePort());
			const ws = new WebSocket(
				`${url.replace(/^http/, "ws")}/subscribe?as=tx-review`,
			);
			await new Promise<void>((resolve) =>
				ws.addEventListener("open", () => resolve()),
			);
			const messages: Record<string, unknown>[] = [];
			ws.addEventListener("message", (event) =>
				messages.push(JSON.parse(String(event.data))),
			);
			let serial = 0;
			const rpc = async (body: Record<string, unknown>) => {
				if (transport === "http")
					return await (
						await fetch(`${url}/rpc`, {
							method: "POST",
							body: JSON.stringify(body),
						})
					).json();
				const id = `tx-rpc-${++serial}`;
				const reply = new Promise<Record<string, unknown>>((resolve) => {
					const receive = (event: MessageEvent) => {
						const frame = JSON.parse(String(event.data));
						if (frame.id === id) {
							ws.removeEventListener("message", receive);
							resolve(frame);
						}
					};
					ws.addEventListener("message", receive);
				});
				ws.send(JSON.stringify({ ...body, id }));
				return await reply;
			};
			const insert = async (txid: string, kind: string) =>
				rpc({
					mode: "run",
					txid,
					sql: "INSERT INTO events (ts,source,kind,payload,target) VALUES (?, ?, ?, ?, ?)",
					params: [Date.now(), "tx-review", kind, "{}", "tx-review"],
				});
			try {
				expect(
					await rpc({ mode: "tx", sql: "begin", txid: "commit-proof" }),
				).toMatchObject({ ok: true });
				await insert("commit-proof", "work.done");
				await insert("commit-proof", "work.landed");
				await Bun.sleep(20);
				expect(messages.filter((m) => m.kind)).toEqual([]);
				expect(
					await rpc({ mode: "tx", sql: "commit", txid: "commit-proof" }),
				).toMatchObject({ ok: true });
				await Bun.sleep(30);
				expect(messages.filter((m) => m.kind).map((m) => m.kind)).toEqual([
					"work.done",
					"work.landed",
				]);
				expect(
					await rpc({ mode: "tx", sql: "begin", txid: "rolled-back" }),
				).toMatchObject({ ok: true });
				await insert("rolled-back", "never.rolled-back");
				await rpc({ mode: "tx", sql: "rollback", txid: "rolled-back" });
				await rpc({ mode: "tx", sql: "begin", txid: "later" });
				await insert("later", "later.committed");
				await rpc({ mode: "tx", sql: "commit", txid: "later" });
				await Bun.sleep(30);
				expect(messages.filter((m) => m.kind).map((m) => m.kind)).toEqual([
					"work.done",
					"work.landed",
					"later.committed",
				]);
				await rpc({
					mode: "run",
					sql: "CREATE TABLE IF NOT EXISTS tx_pub_parent(id INTEGER PRIMARY KEY)",
					params: [],
				});
				await rpc({
					mode: "run",
					sql: "CREATE TABLE IF NOT EXISTS tx_pub_child(parent_id INTEGER REFERENCES tx_pub_parent(id) DEFERRABLE INITIALLY DEFERRED)",
					params: [],
				});
				await rpc({ mode: "tx", sql: "begin", txid: "failed-commit" });
				await insert("failed-commit", "never.failed-commit");
				await rpc({
					mode: "run",
					txid: "failed-commit",
					sql: "INSERT INTO tx_pub_child(parent_id) VALUES (-999)",
					params: [],
				});
				expect(
					await rpc({ mode: "tx", sql: "commit", txid: "failed-commit" }),
				).toMatchObject({ err: expect.stringContaining("commit failed") });
				await Bun.sleep(25);
				expect(messages.filter((m) => m.kind).map((m) => m.kind)).toEqual([
					"work.done",
					"work.landed",
					"later.committed",
				]);
			} finally {
				ws.close();
			}
		},
	);

	test("idle-healed transaction emits nothing and does not replay into the next transaction", async () => {
		const url = await startServer(await freePort());
		const ws = new WebSocket(
			`${url.replace(/^http/, "ws")}/subscribe?as=idle-event-proof`,
		);
		await new Promise<void>((resolve) =>
			ws.addEventListener("open", () => resolve()),
		);
		const messages: Record<string, unknown>[] = [];
		ws.addEventListener("message", (event) =>
			messages.push(JSON.parse(String(event.data))),
		);
		const rpc = async (body: Record<string, unknown>) =>
			(
				await fetch(`${url}/rpc`, {
					method: "POST",
					body: JSON.stringify(body),
				})
			).json();
		const insert = (kind: string) =>
			rpc({
				mode: "run",
				txid: "reused-id",
				sql: "INSERT INTO events (ts,source,kind,payload,target) VALUES (?, ?, ?, ?, ?)",
				params: [
					Date.now(),
					"idle-event-proof",
					kind,
					"{}",
					"idle-event-proof",
				],
			});
		try {
			await rpc({ mode: "tx", sql: "begin", txid: "reused-id" });
			await insert("never.idle-rollback");
			await Bun.sleep(10100);
			await rpc({ mode: "get", sql: "SELECT 1", params: [] }); // actual rollIdle boundary
			await rpc({ mode: "tx", sql: "begin", txid: "reused-id" });
			await insert("fresh.after-idle");
			await rpc({ mode: "tx", sql: "commit", txid: "reused-id" });
			await Bun.sleep(25);
			expect(messages.filter((m) => m.kind).map((m) => m.kind)).toEqual([
				"fresh.after-idle",
			]);
		} finally {
			ws.close();
		}
	}, 15000);

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

test("real subscriber catches an already committed resume control without accepting it", async () => {
	const url = await startServer(await freePort());
	const sid = "ws-paused-resume-catchup";
	const rpc = async (sql: string, params: unknown[]) => {
		const response = await fetch(`${url}/rpc`, {
			method: "POST",
			body: JSON.stringify({ mode: "run", sql, params }),
		});
		expect(response.ok).toBe(true);
		const result = await response.json();
		expect(result.err).toBeUndefined();
		return result;
	};
	await rpc(
		"INSERT INTO sessions(sid,project,started_at,hb,state) VALUES(?,?,?,?,'RUNNING')",
		[sid, projectIdentity(), Date.now(), Date.now()],
	);
	await rpc(
		"INSERT INTO facts(key,value,source,version,ts) VALUES(?,'RESUME_READY','test',1,?)",
		[`lane.${sid}.state`, Date.now()],
	);
	const emitted = await cli(url, [
		"emit",
		"resume_ready",
		"--to",
		sid,
		"--onto=abcdef",
		"--note",
		"real disconnected resume",
		"--as",
		"test-owner",
	]);
	expect(emitted.code).toBe(0);
	const newer = await cli(url, [
		"emit",
		"resume_ready",
		"--to",
		sid,
		"--onto=newer-cut",
		"--note",
		"newest disconnected resume",
		"--as",
		"test-owner",
	]);
	expect(newer.code).toBe(0);
	const sub = Bun.spawn([process.execPath, COORD, "subscribe", "--as", sid], {
		env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: url },
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(sub);
	const file = join(
		home,
		".claude-insights",
		"coord-claude-wake",
		`${createHash("sha256").update(sid).digest("hex")}.json`,
	);
	const deadline = Date.now() + 5000;
	while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(20);
	expect(existsSync(file)).toBe(true);
	const queued = JSON.parse(readFileSync(file, "utf8"));
	expect(queued.kind).toBe("resume_ready");
	expect(queued.sid).toBe(sid);
	expect(queued.text).toContain("newest disconnected resume");
	const receipt = await fetch(`${url}/rpc`, {
		method: "POST",
		body: JSON.stringify({
			mode: "get",
			sql: "SELECT state FROM direct_message_receipts WHERE event_id=? AND sid=?",
			params: [queued.id, sid],
		}),
	});
	const body = await receipt.json();
	expect(JSON.stringify(body)).not.toContain("ACCEPTED");
	const inbox = await cli(url, ["inbox", "--as", sid]);
	expect(inbox.out).toContain("real disconnected resume");
	const state = await cli(url, ["state", "--as", sid]);
	expect(state.out).toContain("RESUME_READY");
	// Accept the newest control while the lifecycle fact still awaits the
	// worker. A reconnect must not fall back to the older unaccepted cut.
	sub.kill();
	await sub.exited;
	await rpc(
		"INSERT OR REPLACE INTO direct_message_receipts(event_id,sid,state,queued_at,accepted_at) VALUES(?,?,'ACCEPTED',?,?)",
		[queued.id, sid, Date.now(), Date.now()],
	);
	rmSync(file);
	const reconnect = Bun.spawn(
		[process.execPath, COORD, "subscribe", "--as", sid],
		{
			env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: url },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	procs.push(reconnect);
	await Bun.sleep(300);
	expect(existsSync(file)).toBe(false);
});
