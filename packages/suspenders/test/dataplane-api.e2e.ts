// dataplane-api.e2e.ts — W2327 co-situated proof: the v0 read-only
// dataplane end to end against a scratch world. The real door
// (hooks/bin/dataplane-api.ts) spawns as a child with a stubbed buckle
// verify leg (serveStub answers /v1/admin/keys/verify), a scratch HOME
// (governor.db isolated), and a scratch fleet root (lanes.json fixtures —
// the honest foreign-lane liveness shape). No live services.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, scratchWorld, serveStub, waitUp } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import type { FieldMap } from "../hooks/lib/dataplane/filter.ts";
import { parseFilter } from "../hooks/lib/dataplane/filter.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

const GOOD_KEY = "bksk_test_dataplane_good";
const NOSCOPE_KEY = "bksk_test_dataplane_noscope";
const DEAD_KEY = "bksk_test_dataplane_dead";

/** The stubbed buckle verify leg: every key known, scope by name. */
const verifyStub = serveStub((_req, body) => {
	const key = typeof body?.key === "string" ? body.key : "";
	if (key === GOOD_KEY)
		return Response.json({
			valid: true,
			key_id: "k1",
			scopes: ["buckle:dataplane:READ_"],
		});
	if (key === NOSCOPE_KEY)
		return Response.json({
			valid: true,
			key_id: "k2",
			scopes: ["buckle:knowledge:READ_"],
		});
	return Response.json({ valid: false, code: "key_not_found" });
});

const world = scratchWorld({ prefix: "dataplane-v0-" });
const fleetRoot = world.repo;
mkdirSync(join(fleetRoot, ".fleet"), { recursive: true });
writeFileSync(
	join(fleetRoot, ".fleet", "lanes.json"),
	JSON.stringify([
		{
			sid: "lane-alpha",
			item: "W1",
			branch: "suspenders/W1",
			pid: 999_997,
			worktree: join(fleetRoot, ".worktrees", "W1"),
			host: "some-other-host",
			launchedAt: Date.now() - 60_000,
		},
		{
			sid: "lane-beta",
			item: "W2",
			branch: "suspenders/W2",
			host: "some-other-host",
			launchedAt: Date.now() - 120_000,
		},
		{
			sid: "lane-gamma",
			item: "W3",
			branch: "suspenders/W3",
			host: "some-other-host",
			launchedAt: Date.now() - 30_000,
		},
		{
			sid: "lane-delta",
			item: "W4",
			branch: "suspenders/W4",
			host: "some-other-host",
			launchedAt: Date.now() - 90_000,
		},
	]),
);

const port = await freePort();
const door = spawn(
	"bun",
	[
		join(import.meta.dir, "..", "hooks", "bin", "dataplane-api.ts"),
		"--port",
		String(port),
	],
	{
		env: {
			...world.env,
			SUSPENDERS_DATAPLANE_FLEET_ROOT: fleetRoot,
			SUSPENDERS_DATAPLANE_VERIFY_URL: verifyStub.url,
			SUSPENDERS_DATAPLANE_VERIFY_TOKEN: "bksk_test_admin",
			GOVERNOR_STORE_URL: "local",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);
const base = `http://127.0.0.1:${port}`;
await waitUp(base);

const call = async (
	method: string,
	body: unknown,
	key = GOOD_KEY,
): Promise<{ status: number; json: unknown }> => {
	const r = await fetch(`${base}/${method}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify(body ?? {}),
	});
	return { status: r.status, json: await r.json().catch(() => null) };
};

test("index documents the v0 method set", async () => {
	const r = await fetch(base);
	const doc = (await r.json()) as { methods: string[] };
	expect(doc.methods).toContain("fleet.work.v1.WorkItems/List");
	expect(doc.methods).toContain("fleet.coord.v1.Lanes/List");
	expect(doc.methods).toContain("fleet.coord.v1.Events/List");
});

test("auth: missing key 401, wrong scope 403, unknown method 404", async () => {
	const anon = await call("fleet.work.v1.WorkItems/List", {}, null);
	expect(anon.status).toBe(401);
	const wrong = await call("fleet.work.v1.WorkItems/List", {}, NOSCOPE_KEY);
	expect(wrong.status).toBe(403);
	const unknown = await call("fleet.work.v1.Bogus/List", {});
	expect(unknown.status).toBe(404);
	const dead = await call("fleet.work.v1.WorkItems/List", {}, DEAD_KEY);
	expect(dead.status).toBe(401);
});

test("work items: seed → List (keyset) → Get; filter and unknown field", async () => {
	// seed through a CHILD bun with the scratch env — an in-process openStore
	// would bind the ambient HOME (the lane's own governor, test pollution)
	const project = projectIdentity(fleetRoot);
	const seed = Bun.spawnSync(
		[
			"bun",
			"-e",
			`
		import { openStore } from ${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts"))};
		import { projectIdentity } from ${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb-project.ts"))};
		const db = openStore();
		const project = projectIdentity(${JSON.stringify(project)});
		const now = Date.now();
		for (const [id, state, priority] of [["W1","READY",0],["W2","DONE",0],["W3","READY",5]]) {
			db.run("INSERT OR REPLACE INTO work_items (project, id, title, state, priority, created_at, updated_at, required) VALUES (?,?,?,?,?,?,?,1)", project, id, "item " + id, state, priority, now, now);
		}
		db.run("INSERT INTO events (ts, source, kind, scope, payload, project) VALUES (?,?,?,?,?,?)", now, "test", "work.claimed", "suspenders", JSON.stringify({ project, work: "W1" }), project);
		db.close();
		`,
		],
		{
			env: {
				...world.env,
				GOVERNOR_STORE_URL: "local",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (seed.exitCode !== 0)
		throw new Error(`seed child failed: ${seed.stderr.toString()}`);

	const list = await call("fleet.work.v1.WorkItems/List", { page_size: 2 });
	expect(list.status).toBe(200);
	expect(list.json.items).toHaveLength(2);
	expect(list.json.next_page_token).toBeTruthy();
	const page2 = await call("fleet.work.v1.WorkItems/List", {
		page_size: 2,
		page_token: list.json.next_page_token,
	});
	expect(page2.status).toBe(200);
	expect(page2.json.items).toHaveLength(1);

	const got = await call("fleet.work.v1.WorkItems/Get", {
		name: `projects/${encodeURIComponent(project)}/workItems/W3`,
	});
	expect(got.status).toBe(200);
	expect(got.json.priority).toBe(5);

	const filtered = await call("fleet.work.v1.WorkItems/List", {
		filter: "state = READY",
	});
	expect(filtered.status).toBe(200);
	expect(filtered.json.items.map((i: { id: string }) => i.id).sort()).toEqual([
		"W1",
		"W3",
	]);

	const bad = await call("fleet.work.v1.WorkItems/List", {
		filter: "bogus_field = 1",
	});
	expect(bad.status).toBe(400);
	expect(JSON.stringify(bad.json)).toContain("bogus_field");

	const missing = await call("fleet.work.v1.WorkItems/Get", {
		name: `projects/${encodeURIComponent(project)}/workItems/W999`,
	});
	expect(missing.status).toBe(404);
});

test("lanes: List renders registry liveness; Get by sid; filter subset", async () => {
	const list = await call("fleet.coord.v1.Lanes/List", {});
	expect(list.status).toBe(200);
	const sids = list.json.items.map((l: { sid: string }) => l.sid);
	expect(sids).toContain("lane-alpha");
	expect(sids).toContain("lane-beta");

	const got = await call("fleet.coord.v1.Lanes/Get", {
		name: "lanes/lane-alpha",
	});
	expect(got.status).toBe(200);
	expect(got.json.item).toBe("W1");

	const state = await call("fleet.coord.v1.Lanes/List", {
		filter: 'state = "dead"',
	});
	expect(state.status).toBe(200);
	// foreign lanes with no fresh transcript read dead on this host
	expect(
		state.json.items.every((l: { state: string }) => l.state === "dead"),
	).toBe(true);

	const compound = await call("fleet.coord.v1.Lanes/List", {
		filter: "state = dead AND host = x",
	});
	expect(compound.status).toBe(400);

	const missing = await call("fleet.coord.v1.Lanes/Get", {
		name: "lanes/nope",
	});
	expect(missing.status).toBe(404);
});

test("lanes pagination: page_token walks pages, no duplicates (B1)", async () => {
	const seen: string[] = [];
	let token: string | null = null;
	let pages = 0;
	do {
		const r = await call("fleet.coord.v1.Lanes/List", {
			page_size: 2,
			...(token ? { page_token: token } : {}),
		});
		expect(r.status).toBe(200);
		const body = r.json as {
			items: { sid: string }[];
			next_page_token: string | null;
		};
		expect(body.items.length).toBeGreaterThan(0);
		expect(body.items.length).toBeLessThanOrEqual(2);
		seen.push(...body.items.map((l) => l.sid));
		token = body.next_page_token;
		pages++;
	} while (token && pages < 10);
	// walked every page without re-serving page 1
	expect(pages).toBeGreaterThanOrEqual(2);
	expect(new Set(seen).size).toBe(seen.length);
	expect(seen.sort()).toEqual([
		"lane-alpha",
		"lane-beta",
		"lane-delta",
		"lane-gamma",
	]);
	// newest first on page 1 (launchedAt desc)
	const page1 = await call("fleet.coord.v1.Lanes/List", { page_size: 2 });
	expect(
		(page1.json as { items: { sid: string }[] }).items.map((l) => l.sid),
	).toEqual(["lane-gamma", "lane-alpha"]);
	// malformed token fails loud, never a silent page 1
	const bad = await call("fleet.coord.v1.Lanes/List", {
		page_token: "not-a-cursor",
	});
	expect(bad.status).toBe(400);
});

test("work items pagination: string order_by walks pages, no duplicates (B2)", async () => {
	// titles ordered differently from insertion AND updated_at order, so an
	// epoch-miskeyed cursor visibly corrupts the walk; P5 carries a NULL
	// description to cover the NULL-aware keyset tail (description column)
	const project = projectIdentity(fleetRoot);
	const seed = Bun.spawnSync(
		[
			"bun",
			"-e",
			`
		import { openStore } from ${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts"))};
		import { projectIdentity } from ${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb-project.ts"))};
		const db = openStore();
		const project = projectIdentity(${JSON.stringify(project)});
		const now = Date.now();
		const rows = [["P1","alpha-patch",now],["P2","zulu-patch",now+1],["P3","midnight-patch",now+2],["P4","beta-patch",now+3],["P5","null-desc-patch",now+4]];
		for (const [id, title, ts] of rows) {
			db.run("INSERT OR REPLACE INTO work_items (project, id, title, state, priority, description, created_at, updated_at, required) VALUES (?,?,?,?,?,?,?,?,1)", project, id, title, "READY", 0, id === "P5" ? null : title, ts, ts);
		}
		db.close();
		`,
		],
		{
			env: { ...world.env, GOVERNOR_STORE_URL: "local" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (seed.exitCode !== 0)
		throw new Error(`seed child failed: ${seed.stderr.toString()}`);
	const seen: string[] = [];
	let token: string | null = null;
	let pages = 0;
	do {
		const r = await call("fleet.work.v1.WorkItems/List", {
			page_size: 2,
			order_by: "title asc",
			...(token ? { page_token: token } : {}),
		});
		expect(r.status).toBe(200);
		const body = r.json as {
			items: { id: string }[];
			next_page_token: string | null;
		};
		// a full final page still carries a token (AIP-158); the terminal
		// fetch answers empty — stop there, never assert it non-empty
		if (body.items.length === 0) break;
		seen.push(...body.items.map((i) => i.id));
		token = body.next_page_token;
		pages++;
	} while (token && pages < 10);
	// every item exactly once, in the DECLARED sort (title asc), which is
	// neither insertion nor updated_at order — a wrong-keyed cursor
	// duplicates or misorders across page boundaries. Includes spec-3's
	// W1–W3 when it ran first: the walk is item-count agnostic.
	expect(new Set(seen).size).toBe(seen.length);
	const titles = seen.map((id) => id);
	expect(titles).toEqual(
		["P1", "P4", "W1", "W2", "W3", "P3", "P5", "P2"].filter((id) =>
			seen.includes(id),
		),
	);
	expect(seen).toContain("P5");
	// malformed token fails loud
	const bad = await call("fleet.work.v1.WorkItems/List", {
		order_by: "title asc",
		page_token: "bogus",
	});
	expect(bad.status).toBe(400);
});

test("events: List keyset desc over the shred column; kind filter", async () => {
	const list = await call("fleet.coord.v1.Events/List", { page_size: 1 });
	expect(list.status).toBe(200);
	expect(list.json.items).toHaveLength(1);
	expect(list.json.items[0].kind).toBe("work.claimed");
	expect(list.json.items[0].work).toBe("W1");
	const filtered = await call("fleet.coord.v1.Events/List", {
		filter: "kind = work.done",
	});
	expect(filtered.status).toBe(200);
	expect(filtered.json.items).toHaveLength(0);
});

test("problem+json shape on errors", async () => {
	const r = await call("fleet.work.v1.WorkItems/Get", { name: "" });
	expect(r.status).toBe(400);
	expect(r.json.type).toContain("urn:klh:problem:");
});

test("unit: parseFilter contract (the W2326 alignment surface)", () => {
	const fields: FieldMap = {
		state: { column: "state" },
		priority: { column: "priority", numeric: true },
	};
	const f = parseFilter("state = READY AND priority >= 3", fields);
	expect(f.sql).toContain("state = ?");
	expect(f.params).toEqual(["READY", 3]);
	const contains = parseFilter("state : block", fields);
	expect(contains.sql).toContain("LIKE ?");
	expect(contains.params).toEqual(["%block%"]);
	expect(() => parseFilter("nope = 1", fields)).toThrow(/nope/);
});

test.afterAll(() => {
	door.kill();
	verifyStub.close();
	world.clean();
});
