import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	handleConsultRelay,
	ensureConsultRelayReceipts,
} from "../hooks/lib/consult-relay-receiver.ts";
import { consultStoreId, enqueueConsult } from "../hooks/lib/consult-outbox.ts";
import {
	relayConsultOutbox,
	type RelayOptions,
} from "../hooks/lib/consult-outbox-relay.ts";

const NOW = 1_790_000_000_000;
function fixture(count = 1) {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE consults(id INTEGER PRIMARY KEY, project TEXT, asker_sid TEXT, expert_sid TEXT, question TEXT, scope TEXT, state TEXT DEFAULT 'OPEN', answer TEXT, created_at INTEGER, answered_at INTEGER)",
	);
	db.run(
		"CREATE TABLE events(id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	consultStoreId(db);
	const deliveries: string[] = [];
	for (let id = 1; id <= count; id++) {
		db.query(
			"INSERT INTO consults(id,project,asker_sid,expert_sid,question,scope,created_at) VALUES (?, 'local-project', 'asker', 'expert', 'How to recover?', 'build', ?)",
		).run(id, NOW);
		deliveries.push(enqueueConsult(db, id, NOW));
	}
	return { db, deliveries };
}
const row = (db: Database) =>
	db
		.query("SELECT * FROM consult_outbox ORDER BY created_at LIMIT 1")
		.get() as Record<string, unknown>;
const request = (
	fn: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch => fn as typeof fetch;
const binding = {
	base: "https://hub.example.invalid",
	token: "secret-not-in-errors",
};

test("lost acknowledgement retries same delivery and maps remote answer to local C ID exactly once", async () => {
	const { db, deliveries } = fixture();
	let now = NOW;
	let posts = 0;
	const receipts = new Map<string, number>();
	const network = request(async (url, init) => {
		expect(init?.redirect).toBe("manual");
		expect(new Headers(init?.headers).get("x-governor-token")).toBe(
			binding.token,
		);
		if (url.endsWith("/health")) return Response.json({ instanceId: "remote" });
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			receipts.set(body.deliveryId, 99);
			posts++;
			if (posts === 1) throw new Error(`failure ${binding.token}`);
			return Response.json({ consultId: 99, state: "OPEN", answer: null });
		}
		expect(url).toEndWith(deliveries[0]);
		return Response.json({
			consultId: 99,
			state: "ANSWERED",
			answer: "Use the existing fix.",
			answeredAt: now,
		});
	});
	const options: RelayOptions = {
		now: () => now,
		resolve: () => binding,
		fetch: network,
		projectAliases: () => ({}),
	};
	await relayConsultOutbox(db, options);
	expect(row(db).last_error).toBe("DELIVERY_REQUEST_FAILED");
	expect(JSON.stringify(row(db))).not.toContain(binding.token);
	now += 1100;
	await relayConsultOutbox(db, options);
	expect(row(db).status).toBe("SENT");
	expect(receipts.size).toBe(1);
	now += 5100;
	await relayConsultOutbox(db, options);
	expect(row(db).status).toBe("ANSWERED");
	expect(db.query("SELECT id,state,answer FROM consults").get()).toEqual({
		id: 1,
		state: "ANSWERED",
		answer: "Use the existing fix.",
	});
	const event = db.query("SELECT payload,target FROM events").get() as {
		payload: string;
		target: string;
	};
	expect(JSON.parse(event.payload)).toMatchObject({
		consult: "C1",
		remoteConsult: "C99",
		deliveryId: deliveries[0],
	});
	expect(event.target).toBe("asker");
	await relayConsultOutbox(db, options);
	expect(db.query("SELECT count(*) n FROM events").get()).toEqual({ n: 1 });
	db.close();
});

test("destination and explicit project mapping stay pinned after configuration changes", async () => {
	const { db } = fixture();
	let now = NOW;
	let current = binding;
	let alias = "remote-project";
	const projects: string[] = [];
	const network = request(async (url, init) => {
		if (url.endsWith("/health")) return Response.json({ instanceId: "remote" });
		projects.push(JSON.parse(String(init?.body)).project);
		throw new Error("lost ack");
	});
	const options = {
		now: () => now,
		resolve: () => current,
		fetch: network,
		projectAliases: () => ({ "local-project": alias }),
	};
	await relayConsultOutbox(db, options);
	current = { ...binding, base: "https://another.example.invalid" };
	now += 1100;
	await relayConsultOutbox(db, options);
	expect(row(db).last_error).toBe("DESTINATION_BINDING_CHANGED");
	expect(projects).toEqual(["remote-project"]);
	current = binding;
	alias = "new-project";
	now += 2100;
	await relayConsultOutbox(db, options);
	expect(projects).toEqual(["remote-project", "remote-project"]);
	db.close();
});

test("local store identity suppresses self-forwarding without a new config", async () => {
	const { db } = fixture();
	const id = consultStoreId(db);
	let requests = 0;
	await relayConsultOutbox(db, {
		now: () => NOW,
		resolve: () => ({ base: "http://127.0.0.1:7795", token: null }),
		fetch: request(async (url) => {
			requests++;
			expect(url).toEndWith("/health");
			return Response.json({ instanceId: id });
		}),
		projectAliases: () => ({}),
	});
	expect(row(db).status).toBe("LOCAL");
	expect(requests).toBe(1);
	expect(db.query("SELECT count(*) n FROM consults").get()).toEqual({ n: 1 });
	db.close();
});

test("expiration emits local correlation while local terminal answers remain intact", async () => {
	const { db } = fixture(2);
	db.run(
		"UPDATE consults SET state='ANSWERED',answer='local proof' WHERE id=2",
	);
	await relayConsultOutbox(db, {
		now: () => NOW + 3_600_001,
		resolve: () => null,
	});
	expect(
		db.query("SELECT id,state,answer FROM consults ORDER BY id").all(),
	).toEqual([
		{ id: 1, state: "EXPIRED", answer: null },
		{ id: 2, state: "ANSWERED", answer: "local proof" },
	]);
	expect(db.query("SELECT count(*) n FROM events").get()).toEqual({ n: 1 });
	db.close();
});

test("unsafe transport and missing remote authentication never make requests", async () => {
	for (const base of [
		"http://hub.example.invalid",
		"https://hub.example.invalid",
	]) {
		const { db } = fixture();
		let requests = 0;
		await relayConsultOutbox(db, {
			now: () => NOW,
			resolve: () => ({ base, token: null }),
			fetch: request(async () => {
				requests++;
				throw new Error("must not call");
			}),
		});
		expect(requests).toBe(0);
		expect(row(db).status).toBe("PENDING");
		db.close();
	}
});

test("a tick has a 20 delivery bound and a second concurrent tick is skipped", async () => {
	const { db } = fixture(21);
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const options = {
		now: () => NOW,
		resolve: () => binding,
		projectAliases: () => ({}),
		fetch: request(async () => {
			calls++;
			await gate;
			return Response.json({ instanceId: consultStoreId(db) });
		}),
	};
	const first = relayConsultOutbox(db, options);
	const second = await relayConsultOutbox(db, options);
	expect(second.busy).toBe(true);
	release?.();
	const result = await first;
	expect(result.processed).toBe(20);
	expect(calls).toBe(1);
	db.close();
});

test("two independent HTTP stores deduplicate a lost ACK and return the expert answer", async () => {
	const local = fixture();
	const remote = fixture(0);
	let now = NOW;
	let posts = 0;
	remote.db.run(
		"CREATE TABLE sessions(sid TEXT PRIMARY KEY, project TEXT, state TEXT, hb INTEGER)",
	);
	remote.db
		.query(
			"INSERT INTO sessions VALUES ('expert', 'remote-project', 'RUNNING', ?)",
		)
		.run(now);
	remote.db
		.query(
			"INSERT INTO consults(id,project,asker_sid,expert_sid,question,scope,state,created_at) VALUES(41,'other','x','x','old','old','ANSWERED',?)",
		)
		.run(now);
	ensureConsultRelayReceipts(remote.db as unknown as GovernorStore);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			if (req.headers.get("x-governor-token") !== "test-token")
				return new Response("Denied", { status: 401 });
			const url = new URL(req.url);
			if (url.pathname === "/health")
				return Response.json({ instanceId: consultStoreId(remote.db) });
			const response = await handleConsultRelay(
				req,
				url,
				remote.db as unknown as GovernorStore,
				undefined,
				now,
			);
			if (req.method === "POST" && ++posts === 1)
				return new Response("Acknowledgement lost after commit", {
					status: 503,
				});
			return response ?? new Response("Missing", { status: 404 });
		},
	});
	try {
		const options = {
			now: () => now,
			resolve: () => ({
				base: `http://127.0.0.1:${server.port}`,
				token: "test-token",
			}),
			projectAliases: () => ({ "local-project": "remote-project" }),
		};
		await relayConsultOutbox(local.db, options);
		expect(row(local.db).status).toBe("PENDING");
		now += 1100;
		await relayConsultOutbox(local.db, options);
		expect(row(local.db).remote_consult_id).toBe(42);
		expect(
			remote.db.query("SELECT count(*) n FROM consult_relay_receipts").get(),
		).toEqual({ n: 1 });
		remote.db
			.query(
				"UPDATE consults SET state='ANSWERED',answer='Verified expert fix',answered_at=? WHERE id=42",
			)
			.run(now);
		now += 5100;
		await relayConsultOutbox(local.db, options);
		expect(
			local.db.query("SELECT id,state,answer FROM consults WHERE id=1").get(),
		).toEqual({ id: 1, state: "ANSWERED", answer: "Verified expert fix" });
		expect(
			JSON.parse(
				(
					local.db.query("SELECT payload FROM events").get() as {
						payload: string;
					}
				).payload,
			),
		).toMatchObject({ consult: "C1", remoteConsult: "C42" });
	} finally {
		server.stop(true);
		local.db.close();
		remote.db.close();
	}
});

test("terminal delivery retention is bounded to seven days", async () => {
	const { db } = fixture();
	db.query("UPDATE consult_outbox SET status='ANSWERED',created_at=?").run(
		NOW - 8 * 86_400_000,
	);
	await relayConsultOutbox(db, { now: () => NOW, resolve: () => null });
	expect(db.query("SELECT count(*) n FROM consult_outbox").get()).toEqual({
		n: 0,
	});
	expect(db.query("SELECT count(*) n FROM consults").get()).toEqual({ n: 1 });
	db.close();
});

test("SQLite default stays local; invalid binding retries without leaking errors and GC clears orphans", async () => {
	const local = fixture();
	await relayConsultOutbox(local.db, { now: () => NOW, resolve: () => null });
	expect(row(local.db).status).toBe("LOCAL");
	local.db.close();
	const pending = fixture();
	await relayConsultOutbox(pending.db, {
		now: () => NOW,
		resolve: () => {
			throw new Error("PRIVATE_TOKEN");
		},
	});
	expect(row(pending.db).last_error).toBe("INVALID_STORE_BINDING");
	pending.db.run("DELETE FROM consults");
	await relayConsultOutbox(pending.db, {
		now: () => NOW + 2000,
		resolve: () => null,
	});
	expect(
		pending.db.query("SELECT count(*) n FROM consult_outbox").get(),
	).toEqual({ n: 0 });
	pending.db.close();
});

test("raw uppercase network error text cannot leak a token", async () => {
	const { db } = fixture();
	await relayConsultOutbox(db, {
		now: () => NOW,
		resolve: () => binding,
		projectAliases: () => ({}),
		fetch: request(async () => {
			throw new Error("PRIVATE_TOKEN");
		}),
	});
	expect(row(db).last_error).toBe("DELIVERY_REQUEST_FAILED");
	db.close();
});

test("temporarily missing binding preserves a SENT delivery and resumes its mapped answer", async () => {
	const { db } = fixture();
	let now = NOW;
	let configured: typeof binding | null = binding;
	const options = {
		now: () => now,
		resolve: () => configured,
		projectAliases: () => ({}),
		fetch: request(async (url, init) => {
			if (url.endsWith("/health"))
				return Response.json({ instanceId: "original-store" });
			return Response.json(
				init?.method === "POST"
					? { consultId: 42, state: "OPEN", answer: null }
					: { consultId: 42, state: "ANSWERED", answer: "resumed answer" },
			);
		}),
	};
	await relayConsultOutbox(db, options);
	configured = null;
	now += 5100;
	await relayConsultOutbox(db, options);
	expect(row(db).status).toBe("SENT");
	expect(row(db).last_error).toBe("BINDING_UNAVAILABLE");
	configured = binding;
	now += 2100;
	await relayConsultOutbox(db, options);
	expect(row(db).status).toBe("ANSWERED");
	expect(db.query("SELECT answer FROM consults").get()).toEqual({
		answer: "resumed answer",
	});
	db.close();
});

test("a URL repointed to a different store cannot answer a pinned delivery", async () => {
	const { db } = fixture();
	let now = NOW;
	let identity = "first-store";
	let remoteCalls = 0;
	const options = {
		now: () => now,
		resolve: () => binding,
		projectAliases: () => ({}),
		fetch: request(async (url) => {
			if (url.endsWith("/health"))
				return Response.json({ instanceId: identity });
			remoteCalls++;
			return Response.json({ consultId: 42, state: "OPEN", answer: null });
		}),
	};
	await relayConsultOutbox(db, options);
	now += 5100;
	identity = "other-store";
	await relayConsultOutbox(db, options);
	expect(row(db).last_error).toBe("STORE_IDENTITY_CHANGED");
	expect(remoteCalls).toBe(1);
	now += 2100;
	identity = consultStoreId(db);
	await relayConsultOutbox(db, options);
	expect(row(db).status).toBe("SENT");
	expect(row(db).last_error).toBe("STORE_IDENTITY_CHANGED");
	expect(remoteCalls).toBe(1);
	db.close();
});

test("invalid acknowledgement states and missing answer values remain pending", async () => {
	for (const state of ["ANSWERED", "INVENTED"]) {
		const { db } = fixture();
		await relayConsultOutbox(db, {
			now: () => NOW,
			resolve: () => binding,
			projectAliases: () => ({}),
			fetch: request(async (url) =>
				Response.json(
					url.endsWith("/health")
						? { instanceId: "remote" }
						: { consultId: 42, state, answer: null },
				),
			),
		});
		expect(row(db).status).toBe("PENDING");
		expect(row(db).last_error).toBe("INVALID_CONSULT_STATE");
		db.close();
	}
});
