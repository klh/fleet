import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureLaneObservations,
	laneObservationSnapshot,
	recordLaneObservation,
} from "../hooks/board/lane-observations.ts";
import {
	readRelayConfig,
	relayCandidates,
	startObservationRelay,
} from "../hooks/board/observation-relay.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const now = 2_000_000;
function database(active = false) {
	const db = new Database(":memory:") as unknown as GovernorStore;
	ensureLaneObservations(db);
	db.run(
		"CREATE TABLE sessions (sid TEXT, project TEXT, hb INTEGER, state TEXT)",
	);
	if (active)
		db.run(
			"INSERT INTO sessions VALUES ('lane-a', '/clone-a/.git', ?, 'RUNNING')",
			now,
		);
	return db;
}
function config(
	dir: string,
	localHub: string,
	targets: { url: string; hubId?: string }[],
) {
	const writeTokenFile = join(dir, `${localHub}.token`);
	writeFileSync(writeTokenFile, "private-test-token", { mode: 0o600 });
	const path = join(dir, `${localHub}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			localHub,
			targets: targets.map((target) => ({ ...target, writeTokenFile })),
		}),
		{ mode: 0o600 },
	);
	return { path, writeTokenFile };
}

test("A to B to C preserves origin and original heartbeat while updating immediate peer; cycles stop", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-"));
	const a = database(true),
		b = database(),
		c = database();
	const configs = [
		config(dir, "A", [{ url: "https://b.local", hubId: "B" }]),
		config(dir, "B", [{ url: "https://c.local", hubId: "C" }]),
		config(dir, "C", [{ url: "https://a.local", hubId: "A" }]),
	];
	const requests: { origin: string; peer: string }[] = [];
	const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new Headers(init?.headers).get("x-klh-write-token")).toBe(
			"private-test-token",
		);
		const body = JSON.parse(String(init?.body));
		requests.push({ origin: body.originHub, peer: body.peerHub });
		const host = new URL(String(input)).hostname;
		const result = recordLaneObservation(
			host === "b.local" ? b : host === "c.local" ? c : a,
			body,
			now,
		);
		return Response.json(result, { status: result.ok ? 200 : 400 });
	}) as typeof fetch;
	const relays = [a, b, c].map((db, i) =>
		startObservationRelay(db, {
			configPath: configs[i].path,
			fetch: transport,
			now: () => now,
			autoStart: false,
		}),
	);
	try {
		await relays[0].tick();
		await relays[1].tick();
		await relays[2].tick();
		expect(requests).toEqual([
			{ origin: "A", peer: "A" },
			{ origin: "A", peer: "B" },
		]);
		const arrived = laneObservationSnapshot(c, null, now).lanes[0];
		expect(arrived).toMatchObject({
			originHub: "A",
			peerHub: "B",
			observedAt: now,
			expiresAt: now + 300_000,
			visitedHubs: ["A", "B"],
			project: "/clone-a/.git",
		});
		const forward = relayCandidates(c, "C", now)[0];
		expect(forward.visitedHubs).toEqual(["A", "B", "C"]);
		expect(forward.peerHub).toBe("C");
		// A legacy target without hubId can receive the loop, but cannot relay it onward.
		recordLaneObservation(a, forward, now);
		a.run("DELETE FROM sessions");
		expect(relayCandidates(a, "A", now)).toHaveLength(0);
		expect(
			a.query("SELECT name FROM sqlite_master WHERE name = 'work_items'").all(),
		).toHaveLength(0);
	} finally {
		relays.forEach((relay) => {
			relay.stop();
		});
		[a, b, c].forEach((db) => {
			db.close();
		});
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dedupe sends changed evidence immediately and refreshes unchanged evidence after 30 seconds", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-"));
	const db = database(true);
	let clock = now,
		requests = 0;
	const relay = startObservationRelay(db, {
		configPath: config(dir, "A", [{ url: "https://b.local" }]).path,
		autoStart: false,
		now: () => clock,
		fetch: (async () => {
			requests++;
			return new Response(null);
		}) as typeof fetch,
	});
	try {
		await relay.tick();
		await relay.tick();
		expect(requests).toBe(1);
		clock += 29_999;
		await relay.tick();
		expect(requests).toBe(1);
		clock++;
		await relay.tick();
		expect(requests).toBe(2);
		db.run("UPDATE sessions SET hb = ?", clock);
		await relay.tick();
		expect(requests).toBe(3);
		expect(relay.status().sent).toBe(3);
	} finally {
		relay.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("token permissions and authentication failures are explicit and never disclose token contents", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-"));
	const db = database(true);
	const conf = config(dir, "A", [{ url: "https://b.local" }]);
	let requests = 0,
		clock = now;
	const relay = startObservationRelay(db, {
		configPath: conf.path,
		autoStart: false,
		now: () => clock,
		fetch: (async () => {
			requests++;
			return new Response(null, { status: 403 });
		}) as typeof fetch,
	});
	try {
		chmodSync(conf.writeTokenFile, 0o644);
		await relay.tick();
		expect(requests).toBe(0);
		expect(relay.status().failed).toBe(1);
		chmodSync(conf.writeTokenFile, 0o600);
		clock += 1000;
		await relay.tick();
		expect(requests).toBe(1);
		expect(relay.status().lastError).toBe("Relay rejected: HTTP 403");
		expect(JSON.stringify(relay.status())).not.toContain("private-test-token");
		expect(relay.status().lastSuccessAt).toBeNull();
	} finally {
		relay.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bounded configuration rejects credentials, unsupported schemes, relative token paths and too many targets", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-"));
	const path = join(dir, "config.json");
	const valid = {
		localHub: "A",
		targets: [{ url: "https://b.local", writeTokenFile: join(dir, "token") }],
	};
	try {
		expect(readRelayConfig(join(dir, "missing"))).toBeNull();
		for (const input of [
			{ ...valid, localHub: "unknown" },
			{ ...valid, targets: Array.from({ length: 9 }, () => valid.targets[0]) },
			{
				...valid,
				targets: [{ ...valid.targets[0], url: "http://user:secret@b.local" }],
			},
			{ ...valid, targets: [{ ...valid.targets[0], url: "file:///tmp" }] },
			{ ...valid, targets: [{ ...valid.targets[0], url: "http://b.local" }] },
			{
				...valid,
				targets: [{ ...valid.targets[0], writeTokenFile: "relative-token" }],
			},
		]) {
			writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
			expect(() => readRelayConfig(path)).toThrow();
		}
		writeFileSync(path, JSON.stringify(valid), { mode: 0o600 });
		expect(readRelayConfig(path)?.localHub).toBe("A");
		chmodSync(path, 0o644);
		expect(() => readRelayConfig(path)).toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("relay requests never overlap ticks and at most four requests run concurrently", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-"));
	const db = database();
	for (let i = 0; i < 8; i++)
		db.run(
			"INSERT INTO sessions VALUES (?, '/fleet', ?, 'RUNNING')",
			`lane-${i}`,
			now,
		);
	let active = 0,
		maxActive = 0,
		requests = 0;
	const relay = startObservationRelay(db, {
		configPath: config(dir, "A", [{ url: "https://b.local" }]).path,
		autoStart: false,
		now: () => now,
		fetch: (async () => {
			requests++;
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
			return new Response(null);
		}) as typeof fetch,
	});
	try {
		await Promise.all([relay.tick(), relay.tick()]);
		expect(requests).toBe(8);
		expect(maxActive).toBe(4);
		expect(relay.status().busy).toBe(false);
	} finally {
		relay.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("real HTTP transport sends authenticated observations and rejects a wrong write token", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-http-"));
	let clock = now;
	const source = database(true),
		receiver = database();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.headers.get("x-klh-write-token") !== "private-test-token")
				return new Response(null, { status: 403 });
			if (new URL(request.url).pathname !== "/api/lane-observations")
				return new Response(null, { status: 404 });
			const result = recordLaneObservation(receiver, await request.json(), now);
			return Response.json(result, { status: result.ok ? 200 : 400 });
		},
	});
	const conf = config(dir, "A", [
		{ url: `http://127.0.0.1:${server.port}`, hubId: "B" },
	]);
	const relay = startObservationRelay(source, {
		configPath: conf.path,
		autoStart: false,
		now: () => clock,
	});
	try {
		writeFileSync(conf.writeTokenFile, "wrong-token");
		await relay.tick();
		expect(relay.status().lastError).toBe("Relay rejected: HTTP 403");
		expect(laneObservationSnapshot(receiver, null, now).lanes).toHaveLength(0);
		writeFileSync(conf.writeTokenFile, "private-test-token");
		clock += 1000;
		await relay.tick();
		expect(laneObservationSnapshot(receiver, null, now).lanes[0]).toMatchObject(
			{ originHub: "A", peerHub: "A", visitedHubs: ["A"] },
		);
		expect(relay.status().lastSuccessAt).toBe(clock);
		expect(JSON.stringify(relay.status())).not.toContain("private-test-token");
	} finally {
		relay.stop();
		server.stop(true);
		source.close();
		receiver.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rotating batches remain capped at 100 without starving later lanes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-batch-"));
	const db = database();
	for (let i = 0; i < 160; i++)
		db.run(
			"INSERT INTO sessions VALUES (?, '/fleet', ?, 'RUNNING')",
			`lane-${String(i).padStart(3, "0")}`,
			now,
		);
	let requests = 0,
		clock = now;
	const seen = new Set<string>();
	const relay = startObservationRelay(db, {
		configPath: config(dir, "A", [{ url: "https://b.local" }]).path,
		autoStart: false,
		now: () => clock,
		fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests++;
			seen.add(JSON.parse(String(init?.body)).laneId);
			return new Response(null);
		}) as typeof fetch,
	});
	try {
		await relay.tick();
		expect(requests).toBe(100);
		clock++;
		db.run("UPDATE sessions SET hb = ?", clock);
		await relay.tick();
		expect(requests).toBe(200);
		expect(seen.size).toBe(160);
	} finally {
		relay.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("relay never rejuvenates expired or inactive lane evidence", () => {
	const db = database(true);
	try {
		db.run("INSERT INTO sessions VALUES ('quiet', '/fleet', ?, 'CLOSED')", now);
		db.run(
			"INSERT INTO sessions VALUES ('old', '/fleet', ?, 'RUNNING')",
			now - 300_000,
		);
		db.run(
			"INSERT INTO sessions VALUES ('future', '/fleet', ?, 'RUNNING')",
			now + 5001,
		);
		recordLaneObservation(
			db,
			{
				laneId: "old-remote",
				project: "/fleet",
				originHub: "X",
				peerHub: "B",
				observedAt: now - 300_001,
				expiresAt: now + 60_000,
				visitedHubs: ["X", "B"],
			},
			now,
		);
		expect(relayCandidates(db, "A", now).map((lane) => lane.laneId)).toEqual([
			"lane-a",
		]);
		db.run("DELETE FROM sessions WHERE sid = 'future'");
		expect(relayCandidates(db, "A", now + 300_000)).toHaveLength(0);
	} finally {
		db.close();
	}
});

test("adaptive drain forwards 1000 lanes to eight hubs inside evidence TTL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-capacity-"));
	const db = database();
	db.transaction(() => {
		for (let i = 0; i < 1000; i++)
			db.run(
				"INSERT INTO sessions VALUES (?, '/fleet', ?, 'RUNNING')",
				`lane-${String(i).padStart(4, "0")}`,
				now,
			);
	})();
	let clock = now,
		requests = 0;
	const seen = new Set<string>();
	const targets = Array.from({ length: 8 }, (_, i) => ({
		url: `https://hub-${i}.local`,
		hubId: `hub-${i}`,
	}));
	const relay = startObservationRelay(db, {
		configPath: config(dir, "A", targets).path,
		autoStart: false,
		now: () => clock,
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests++;
			clock++;
			seen.add(`${input}:${JSON.parse(String(init?.body)).laneId}`);
			return new Response(null);
		}) as typeof fetch,
	});
	try {
		await relay.tick();
		expect(requests).toBe(100);
		expect(relay.status().backlog).toBe(7900);
		const deadline = Date.now() + 10_000;
		while (
			(relay.status().busy || relay.status().backlog) &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(requests).toBe(8000);
		expect(seen.size).toBe(8000);
		expect(relay.status().backlog).toBe(0);
		expect(clock - now).toBeLessThan(300_000);
		expect(relay.status().failed).toBe(0);
	} finally {
		relay.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);

test("a failed target stays visible in backlog and cannot cause a hot retry loop", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-relay-backoff-"));
	const db = database();
	for (let i = 0; i < 160; i++)
		db.run(
			"INSERT INTO sessions VALUES (?, '/fleet', ?, 'RUNNING')",
			`lane-${i}`,
			now,
		);
	let requests = 0,
		clock = now;
	const relay = startObservationRelay(db, {
		configPath: config(dir, "A", [{ url: "https://bad.local" }]).path,
		autoStart: false,
		now: () => clock,
		fetch: (async () => {
			requests++;
			return new Response(null, { status: 403 });
		}) as typeof fetch,
	});
	try {
		await relay.tick();
		expect(requests).toBeLessThanOrEqual(4);
		expect(relay.status().backlog).toBe(160);
		expect(relay.status().nextRetryAt).toBe(now + 1000);
		expect(relay.status().lastError).toBe("Relay rejected: HTTP 403");
		const first = requests;
		await relay.tick();
		expect(requests).toBe(first);
		expect(relay.status().lastError).toBe("Relay rejected: HTTP 403");
		clock += 1000;
		await relay.tick();
		expect(requests).toBeGreaterThan(first);
		expect(relay.status().nextRetryAt).toBe(clock + 2000);
	} finally {
		relay.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
