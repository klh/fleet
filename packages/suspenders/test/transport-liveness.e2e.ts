// W1302.5 — transport-liveness: the buckle in-flight index as a liveness
// term. Active (queued/held/streaming) rows named for a lane's sid are
// production evidence; missing evidence never blocks; the probe memoizes;
// the kill-switch disables without a fetch.
import { expect, test } from "./pw";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	ACTIVE_INFLIGHT_STATES,
	createTransportProbe,
	fetchInflightLanes,
	transportAliveByLanes,
} from "../hooks/lib/lanes/transport-liveness.ts";
import { laneVerdict } from "../hooks/lib/lanes/lane-liveness.ts";
import { probeClaim } from "../hooks/lib/lanes/reclaim-liveness.ts";

const databases: Database[] = [];
const servers: Array<{ stop: () => void }> = [];

test.afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const s of servers.splice(0)) s.stop();
	delete process.env.SUSPENDERS_TRANSPORT_PROBE;
});

function fixture(): GovernorStore {
	const db = new Database(":memory:");
	databases.push(db);
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	return {
		local: true,
		query: (sql) => db.query(sql),
		run: (sql, ...params) => db.run(sql, ...(params as never[])),
		transaction: <T>(fn: () => T) => db.transaction(fn),
		close: () => db.close(),
	};
}

test("classifier: ACTIVE rows name lanes; settled/denied/blank rows never do", () => {
	const map = transportAliveByLanes([
		{ lane: "a-sid", state: "queued", start_ms: 1 },
		{ lane: "b-sid", state: "held", start_ms: 2 },
		{ lane: "c-sid", state: "streaming", start_ms: 3 },
		{ lane: "a-sid", state: "settled", start_ms: 4 },
		{ lane: "", state: "streaming", start_ms: 5 },
		{ lane: "d-sid", state: "denied", start_ms: 6 },
	]);
	expect(map.get("a-sid")).toBe(true);
	expect(map.get("b-sid")).toBe(true);
	expect(map.get("c-sid")).toBe(true);
	expect(map.has("d-sid")).toBe(false);
	expect(ACTIVE_INFLIGHT_STATES.has("settled")).toBe(false);
});

test("fetcher: token-gated index read; 401 and odd shapes read unavailable", async () => {
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			seen.push(new URL(req.url).pathname);
			const auth = req.headers.get("authorization") ?? "";
			if (auth !== "Bearer tk") return new Response("denied", { status: 401 });
			if (new URL(req.url).pathname !== "/v1/admin/inflight")
				return new Response("no", { status: 404 });
			return Response.json({
				requests: [{ lane: "a-sid", state: "streaming", start_ms: 9 }],
			});
		},
	});
	servers.push(server);
	const rows = await fetchInflightLanes(
		`http://127.0.0.1:${server.port}`,
		"tk",
	);
	expect(seen).toEqual(["/v1/admin/inflight"]);
	expect(rows?.length).toBe(1);
	expect(rows?.[0]?.lane).toBe("a-sid");
	expect(
		await fetchInflightLanes(`http://127.0.0.1:${server.port}`, "no"),
	).toBe(null);
	expect(await fetchInflightLanes(null, "tk")).toBe(null);
	expect(await fetchInflightLanes("", "tk")).toBe(null);
	const slow = Bun.serve({
		port: 0,
		fetch: async () => {
			await new Promise((r) => setTimeout(r, 250));
			return Response.json({ requests: [] });
		},
	});
	servers.push(slow);
	expect(
		await fetchInflightLanes(`http://127.0.0.1:${slow.port}`, "tk", 20),
	).toBe(null); // 20ms bound < the 250ms handler — abort reads unavailable
});

test("probe: memoized per ttl; unavailable reads available:false; kill-switch skips the fetch", async () => {
	let calls = 0;
	const rows = [{ lane: "a-sid", state: "held", start_ms: 1 }];
	const probe = createTransportProbe({
		fetcher: async () => {
			calls++;
			return rows;
		},
		ttlMs: 50,
	});
	const first = await probe.probe();
	expect(first.available).toBe(true);
	expect(first.alive.get("a-sid")).toBe(true);
	await probe.probe();
	expect(calls).toBe(1); // memo hit
	await new Promise((r) => setTimeout(r, 60));
	await probe.probe();
	expect(calls).toBe(2); // ttl expired
	const dead = createTransportProbe({
		fetcher: async () => null,
		ttlMs: 50,
	});
	expect((await dead.probe()).available).toBe(false);
	process.env.SUSPENDERS_TRANSPORT_PROBE = "0";
	let killed = 0;
	const off = createTransportProbe({
		fetcher: async () => {
			killed++;
			return rows;
		},
	});
	expect((await off.probe()).available).toBe(false);
	expect(killed).toBe(0);
});

test("laneVerdict: transport alive outranks dead identity and foreign-host unknown", () => {
	const transport = new Map([["a-sid", true]]);
	// local lane, pid provably gone → would read dead; transport rescues
	expect(
		laneVerdict(
			{ sid: "a-sid", item: "W1", pid: 1, host: hostname() },
			() => ({ exitCode: 0, stdout: `  9999 0:01 /sbin/launchd\n` }),
			undefined,
			transport,
		),
	).toBe("alive");
	// foreign host with no transcript → would read unknown; transport rescues
	expect(
		laneVerdict(
			{ sid: "a-sid", item: "W1", pid: 1, host: "other-host" },
			() => ({ exitCode: 0, stdout: "" }),
			undefined,
			transport,
		),
	).toBe("alive");
	// no transport term → verdicts unchanged (dead / unknown)
	expect(
		laneVerdict({ sid: "a-sid", item: "W1", pid: 1, host: hostname() }, () => ({
			exitCode: 0,
			stdout: `  9999 0:01 /sbin/launchd\n`,
		})),
	).toBe("dead");
	expect(
		laneVerdict(
			{ sid: "a-sid", item: "W1", pid: 1, host: "other-host" },
			() => ({
				exitCode: 0,
				stdout: "",
			}),
		),
	).toBe("unknown");
});

test("probeClaim: transport evidence keeps a producing claimant out of the reaper", () => {
	const store = fixture();
	const transport = new Map([["own-sid", true]]);
	// no registry entry (manual take) + session row positively absent → the
	// W972 death path would read dead; transport rescues BEFORE it can fire
	expect(
		probeClaim(store, "proj", {
			id: "W1",
			owner: "own-sid",
			revision: 1,
			transport,
		}).verdict,
	).toBe("alive");
});

test("loop wiring: stall-watch holds the verdict on an ACTIVE gate request; the sweep passes the term", () => {
	const watchdog = readFileSync(
		new URL("../hooks/lib/fleet-loop/stall-watch.ts", import.meta.url),
		"utf8",
	);
	// the O1 guard sits before watchLane and reads the per-tick snapshot
	expect(watchdog).toContain("inflight?.get(l.sid) === true");
	expect(watchdog).toContain("lane.resumed");
	expect(watchdog).toContain("transportRefresh");
	const sweep = readFileSync(
		new URL("../hooks/lib/fleet-loop/reclaim-sweep.ts", import.meta.url),
		"utf8",
	);
	expect(sweep).toContain("reclaimAll(");
	expect(sweep).toContain("transport.probe()");
	const core = readFileSync(
		new URL("../hooks/lib/lanes/reclaim-all.ts", import.meta.url),
		"utf8",
	);
	expect(core).toContain("transport,");
});

// W1302.5.1 B1: the probe's fetch path must be the W1259 route buckle
// actually serves — route-table + admin dispatch cross-checked against the
// source, so a rename on either side goes red here instead of silently
// reading "unavailable" forever.
test("endpoint cross-check: the probe fetches the served /v1/admin/inflight route", () => {
	const table = readFileSync(
		new URL("../../buckle/src/citizenship.ts", import.meta.url),
		"utf8",
	);
	expect(table).toContain('path === "/v1/admin/inflight"');
	expect(table).toContain('"/v1/admin/inflight") return "GET, OPTIONS"');
	const admin = readFileSync(
		new URL("../../buckle/src/gov/admin.ts", import.meta.url),
		"utf8",
	);
	expect(admin).toContain('method === "GET" && path === "/v1/admin/inflight"');
	const probe = readFileSync(
		new URL("../hooks/lib/lanes/transport-liveness.ts", import.meta.url),
		"utf8",
	);
	expect(probe).toContain('"/v1/admin/inflight"');
});
