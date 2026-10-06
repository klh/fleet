import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureConsultRelayReceipts,
	handleConsultRelay,
	type RelayConsultRequest,
} from "../hooks/lib/consult-relay-receiver.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const now = 2_000_000;
function fixture() {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.run("PRAGMA foreign_keys = ON");
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY,project TEXT,state TEXT,hb INTEGER)",
	);
	db.run(
		"CREATE TABLE consults (id INTEGER PRIMARY KEY AUTOINCREMENT,project TEXT,asker_sid TEXT,expert_sid TEXT,question TEXT,scope TEXT,state TEXT,answer TEXT,created_at INTEGER,answered_at INTEGER)",
	);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	db.run(
		"INSERT INTO sessions VALUES ('expert', '/fleet/.git', 'RUNNING', ?)",
		now,
	);
	ensureConsultRelayReceipts(db);
	return db;
}
const delivery = (
	overrides: Partial<RelayConsultRequest> = {},
): RelayConsultRequest => ({
	deliveryId: crypto.randomUUID(),
	project: "/fleet/.git",
	askerSid: "asker-from-other-hub",
	expertSid: "expert",
	question: "What caused this failure?",
	scope: "api/service",
	createdAt: now,
	...overrides,
});
function send(
	db: GovernorStore,
	body: unknown,
	notify?: (eventId: number) => void,
	clock = now,
) {
	const url = new URL("http://127.0.0.1/consult-relay");
	return handleConsultRelay(
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		url,
		db,
		notify,
		clock,
	);
}
async function get(db: GovernorStore, id: string, clock = now) {
	const url = new URL(`http://127.0.0.1/consult-relay/${id}`);
	return handleConsultRelay(new Request(url), url, db, undefined, clock);
}

test("lost acknowledgement replay maps to one remote consult and one targeted event", async () => {
	const db = fixture();
	const body = delivery();
	let notified = 0;
	try {
		// The destination ledger already has unrelated IDs; sender local IDs never travel as remote IDs.
		db.run(
			"INSERT INTO consults (id, project, state, created_at) VALUES (41, '/other', 'ANSWERED', ?)",
			now,
		);
		const notify = (id: number) => {
			expect(
				db.query("SELECT target FROM events WHERE id = ?").get(id),
			).toEqual({ target: "expert" });
			expect(
				db.query("SELECT COUNT(*) AS n FROM consult_relay_receipts").get(),
			).toEqual({ n: 1 });
			notified++;
		};
		const first = await send(db, body, notify);
		expect(first?.status).toBe(200);
		const firstReply = await first?.json();
		expect(firstReply.consultId).toBe(42);
		db.run("UPDATE sessions SET state = 'CLOSED'");
		const retried = await send(db, body, notify);
		expect(await retried?.json()).toEqual(firstReply);
		expect(notified).toBe(1);
		expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
			n: 1,
		});
		expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({
			n: 1,
		});
		db.run(
			"UPDATE consults SET state = 'ANSWERED', answer = 'Verified candidate', answered_at = ? WHERE id = ?",
			now + 10,
			firstReply.consultId,
		);
		expect(await (await get(db, body.deliveryId))?.json()).toMatchObject({
			consultId: 42,
			state: "ANSWERED",
			answer: "Verified candidate",
			answeredAt: now + 10,
			expertSid: "expert",
		});
		expect((await send(db, { ...body, question: "changed" }))?.status).toBe(
			409,
		);
	} finally {
		db.close();
	}
});

test("concurrent identical deliveries create one consult atomically", async () => {
	const db = fixture();
	const body = delivery();
	try {
		const replies = await Promise.all(
			Array.from({ length: 8 }, async () => (await send(db, body))?.json()),
		);
		expect(new Set(replies.map((reply) => reply.consultId)).size).toBe(1);
		expect(db.query("SELECT COUNT(*) AS n FROM consults").get()).toEqual({
			n: 1,
		});
		expect(
			db.query("SELECT COUNT(*) AS n FROM consult_relay_receipts").get(),
		).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});

test("missing, stale and different-project experts never manufacture a session", async () => {
	const db = fixture();
	try {
		expect((await send(db, delivery({ expertSid: "missing" })))?.status).toBe(
			503,
		);
		expect((await send(db, delivery({ project: "/other/.git" })))?.status).toBe(
			503,
		);
		db.run("UPDATE sessions SET hb = ?", now - 300_001);
		expect((await send(db, delivery()))?.status).toBe(503);
		expect(db.query("SELECT COUNT(*) AS n FROM consults").get()).toEqual({
			n: 0,
		});
		expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({
			n: 1,
		});
	} finally {
		db.close();
	}
});

test("per-asker and per-expert open queues are independently bounded", async () => {
	const db = fixture();
	try {
		for (let i = 0; i < 2; i++) {
			db.run(
				"INSERT INTO consults (project, asker_sid, expert_sid, state, created_at) VALUES ('/fleet/.git', 'asker-from-other-hub', 'someone-else', 'OPEN', ?)",
				now,
			);
			db.run(
				"INSERT INTO consults (project, asker_sid, expert_sid, state, created_at) VALUES ('/fleet/.git', 'another-asker', 'expert', 'OPEN', ?)",
				now,
			);
		}
		expect((await send(db, delivery()))?.status).toBe(200);
		expect((await send(db, delivery()))?.status).toBe(429);
		db.run(
			"UPDATE consults SET state = 'ANSWERED' WHERE asker_sid = 'asker-from-other-hub'",
		);
		expect((await send(db, delivery({ askerSid: "new-asker" })))?.status).toBe(
			200,
		);
	} finally {
		db.close();
	}
});

test("malformed, oversized, expired and future requests are rejected without inserts", async () => {
	const db = fixture();
	try {
		for (const invalid of [
			delivery({ deliveryId: "not-a-uuid" }),
			delivery({ expertSid: "x".repeat(129) }),
			delivery({ project: "bad\u0000project" }),
			delivery({ scope: "" }),
			delivery({ question: "x".repeat(8193) }),
			{ ...delivery(), extra: "unknown" },
		])
			expect((await send(db, invalid))?.status).toBe(400);
		expect(
			(await send(db, delivery({ createdAt: now - 3_600_001 })))?.status,
		).toBe(410);
		expect((await send(db, delivery({ createdAt: now + 5001 })))?.status).toBe(
			400,
		);
		expect(
			(await send(db, delivery({ question: "😀".repeat(8000) })))?.status,
		).toBe(413);
		expect(db.query("SELECT COUNT(*) AS n FROM consults").get()).toEqual({
			n: 0,
		});
		expect((await get(db, crypto.randomUUID()))?.status).toBe(404);
	} finally {
		db.close();
	}
});

test("receipt migration preserves mappings and consult pruning cascades", () => {
	const db = fixture();
	try {
		db.run(
			"INSERT INTO consults (id, project, state, created_at) VALUES (99, '/fleet/.git', 'ANSWERED', ?)",
			now,
		);
		db.run("DROP TABLE consult_relay_receipts");
		db.run(
			"CREATE TABLE consult_relay_receipts (delivery_id TEXT PRIMARY KEY,consult_id INTEGER NOT NULL UNIQUE REFERENCES consults(id),payload_hash TEXT NOT NULL)",
		);
		const id = crypto.randomUUID();
		db.query(
			"INSERT INTO consult_relay_receipts VALUES (?,99,'previous-hash')",
		).run(id);
		ensureConsultRelayReceipts(db);
		expect(
			db
				.query(
					"SELECT consult_id FROM consult_relay_receipts WHERE delivery_id = ?",
				)
				.get(id),
		).toEqual({ consult_id: 99 });
		db.run("DELETE FROM consults WHERE id = 99");
		expect(
			db.query("SELECT COUNT(*) AS n FROM consult_relay_receipts").get(),
		).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});

test("bounded receipts reject admissions at capacity and prune old mappings", async () => {
	const db = fixture();
	try {
		db.transaction(() => {
			for (let i = 1; i <= 10_000; i++) {
				db.query(
					"INSERT INTO consults (id,project,state,created_at) VALUES (?,'/fleet/.git','ANSWERED',?)",
				).run(i, now);
				db.query("INSERT INTO consult_relay_receipts VALUES (?,?,?)").run(
					crypto.randomUUID(),
					i,
					"old-hash",
				);
			}
		})();
		expect((await send(db, delivery()))?.status).toBe(503);
		db.query("UPDATE consults SET created_at = ? WHERE id = 1").run(
			now - 604_800_001,
		);
		expect((await send(db, delivery()))?.status).toBe(200);
		expect(
			db.query("SELECT COUNT(*) AS n FROM consult_relay_receipts").get(),
		).toEqual({ n: 10_000 });
	} finally {
		db.close();
	}
});

test("actual store HTTP endpoints enforce token auth and push the targeted consult event", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-consult-receiver-"));
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(null),
	});
	const port = probe.port;
	probe.stop(true);
	const server = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "../hooks/bin/store-server.ts"),
			"--port",
			String(port),
		],
		{
			env: {
				...process.env,
				HOME: home,
				GOVERNOR_STORE_TOKEN: "receiver-test-token",
				GOVERNOR_STORE_URL: "local",
			},
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const origin = `http://127.0.0.1:${port}`;
	let socket: WebSocket | null = null;
	try {
		let ready = false;
		for (let i = 0; i < 50; i++) {
			try {
				const reply = await fetch(`${origin}/health`);
				if (reply.ok) {
					const health = await reply.json();
					expect(health.instanceId).toMatch(UUID_PATTERN);
					ready = true;
					break;
				}
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (!ready)
			throw new Error(
				`Isolated store did not start: ${await new Response(server.stderr).text()}`,
			);
		const clock = Date.now();
		const body = delivery({ createdAt: clock });
		const request = (
			path: string,
			method = "GET",
			token = "receiver-test-token",
			payload?: unknown,
		) =>
			fetch(`${origin}${path}`, {
				method,
				headers: {
					"x-governor-token": token,
					"content-type": "application/json",
				},
				...(payload ? { body: JSON.stringify(payload) } : {}),
			});
		expect(
			(await request("/consult-relay", "POST", "wrong", body)).status,
		).toBe(403);
		await request("/rpc", "POST", "receiver-test-token", {
			mode: "run",
			sql: "INSERT INTO sessions (sid,role,state,parent_sid,project,hb,started_at) VALUES ('expert','worker','RUNNING',NULL,?,?,?)",
			params: [body.project, clock, clock],
		});
		socket = new WebSocket(
			`${origin.replace("http", "ws")}/subscribe?as=expert&token=receiver-test-token`,
		);
		await new Promise<void>((resolve, reject) => {
			if (socket) {
				socket.onopen = () => resolve();
				socket.onerror = () => reject(new Error("Isolated subscriber failed"));
			}
		});
		const event = new Promise<Record<string, unknown>>((resolve) => {
			if (socket)
				socket.onmessage = (message) =>
					resolve(JSON.parse(String(message.data)));
		});
		const reply = await request(
			"/consult-relay",
			"POST",
			"receiver-test-token",
			body,
		);
		expect(reply.status).toBe(200);
		const consult = await reply.json();
		expect(
			await Promise.race([
				event,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("No targeted event")), 1000),
				),
			]),
		).toMatchObject({
			kind: "consult",
			target: "expert",
			source: body.askerSid,
		});
		expect(
			(await request(`/consult-relay/${body.deliveryId}`, "GET", "wrong"))
				.status,
		).toBe(403);
		expect(
			await (await request(`/consult-relay/${body.deliveryId}`)).json(),
		).toEqual(consult);
	} finally {
		socket?.close();
		server.kill();
		await server.exited;
		rmSync(home, { recursive: true, force: true });
	}
}, 10_000);

test("receiver requires configured authority and accepts only a private explicit server token file", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-consult-server-auth-"));
	const tokenFile = join(home, "server-token");
	writeFileSync(tokenFile, "private-file-token", { mode: 0o600 });
	try {
		for (const kind of ["unconfigured", "private", "public"]) {
			if (kind === "public") chmodSync(tokenFile, 0o644);
			const probe = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response(null),
			});
			const port = probe.port;
			probe.stop(true);
			const server = Bun.spawn(
				[
					"bun",
					join(import.meta.dir, "../hooks/bin/store-server.ts"),
					"--port",
					String(port),
				],
				{
					env: {
						...process.env,
						HOME: home,
						GOVERNOR_STORE_TOKEN: "",
						GOVERNOR_STORE_SERVER_TOKEN_FILE:
							kind === "unconfigured" ? "" : tokenFile,
						GOVERNOR_STORE_URL: "local",
					},
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			try {
				const origin = `http://127.0.0.1:${port}`;
				let healthy: { consultRelayReady: boolean } | null = null;
				for (let i = 0; i < 50; i++) {
					try {
						const response = await fetch(`${origin}/health`);
						if (response.ok) {
							healthy = await response.json();
							break;
						}
					} catch {}
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				expect(healthy?.consultRelayReady).toBe(kind === "private");
				const reply = await fetch(
					`${origin}/consult-relay/${crypto.randomUUID()}`,
					{ headers: { "x-governor-token": "private-file-token" } },
				);
				expect(reply.status).toBe(kind === "private" ? 404 : 503);
				const rpc = (token = "") =>
					fetch(`${origin}/rpc`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-governor-token": token,
						},
						body: JSON.stringify({ mode: "get", sql: "SELECT 1", params: [] }),
					});
				expect((await rpc()).status).toBe(
					kind === "private" ? 403 : kind === "public" ? 503 : 200,
				);
				if (kind === "private")
					expect((await rpc("private-file-token")).status).toBe(200);
				if (kind === "private")
					expect(
						(await fetch(`${origin}/consult-relay/${crypto.randomUUID()}`))
							.status,
					).toBe(403);
			} finally {
				server.kill();
				await server.exited;
			}
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 10_000);

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
