// test/federation-work.test.ts — W370 federated work view: the local feed
// (open work, minimal wire, honest cap), wire parsing, per-edge pull with
// last-known degradation, edge-token precedence, and the board's serve +
// view routes (bearer auth, page render). The e2e leg closes the loop:
// the pull rides the serve route over loopback — lib ↔ route agree.

import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { mkdirSync } from "node:fs";
import { tmpDir } from "./helpers/fixture-kit.ts";

import { federationWorkPage } from "../hooks/bin/federation-work-html.ts";
import { handleFederationWork } from "../hooks/board/routes-federation.ts";
import {
	type FedWorkRow,
	localWorkFeed,
	parseWorkFeed,
	pullFederatedWork,
	type WorkEnv,
	workEdgeToken,
} from "../hooks/lib/federation/federation-work.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb-store.ts";

function fixtureStore(): GovernorStore {
	const d = new Database(":memory:") as unknown as GovernorStore;
	d.local = true;
	d.run(`CREATE TABLE work_items (
		project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
		description TEXT, state TEXT NOT NULL DEFAULT 'READY',
		priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT,
		scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1,
		requires TEXT, tags TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		PRIMARY KEY (project, id)
	)`);
	// multi-project: the feed carries every project's open work on this machine
	const seed = (
		id: string,
		state: string,
		title: string,
		priority = 0,
	): void => {
		d.run(
			`INSERT INTO work_items (project, id, state, title, priority, owner_sid, created_at, updated_at)
			 VALUES ('p', ?, ?, ?, ?, 'lane-x', 1, 1)`,
			id,
			state,
			title,
			priority,
		);
	};
	d.run(
		"INSERT INTO work_items (project, id, title, state, priority, owner_sid, created_at, updated_at) VALUES ('p2', 'Z1', 'other project', 'READY', 5, NULL, 1, 1)",
	);
	seed("W2", "READY", "second", 1);
	seed("W1", "CLAIMED", "first", 9);
	seed("W3", "DONE", "history", 9);
	seed("W4", "SUPERSEDED", "gone", 1);
	return d;
}

function tmpEnv() {
	const home = tmpDir("w370-work-");
	mkdirSync(home, { recursive: true });
	return { env: { BUCKLE_SECRETS_HOME: home, HOME: home } as WorkEnv, home };
}

test.describe("localWorkFeed", () => {
	test("open work only, priority-top, minimal wire", () => {
		const d = fixtureStore();
		const feed = localWorkFeed({ store: d, env: { KLH_HUB_NAME: "lab" } });
		expect(feed.hub).toBe("lab");
		expect(feed.total).toBe(3);
		expect(feed.trunc).toBe(false);
		expect(feed.items.map((i) => i.id)).toEqual(["W1", "Z1", "W2"]);
		expect(feed.items[0].owner_sid).toBe("lane-x");
	});
	test("cap keeps the count honest", () => {
		const d = fixtureStore();
		const feed = localWorkFeed({ store: d, cap: 2 });
		expect(feed.items.length).toBe(2);
		expect(feed.total).toBe(3);
		expect(feed.trunc).toBe(true);
	});
});

test.describe("parseWorkFeed", () => {
	test("drops malformed rows, honest total", () => {
		const feed = parseWorkFeed({
			hub: "nas",
			items: [
				{ id: "W9", title: "ok", state: "READY", owner_sid: null },
				{ id: 42, state: "READY" },
				"junk",
			],
			total: 2,
			trunc: true,
		});
		expect(feed).not.toBeNull();
		expect(feed.items.length).toBe(1);
		expect(feed.total).toBe(2);
		expect(feed.trunc).toBe(true);
		expect(feed.hub).toBe("nas");
	});
	test("null on missing hub or items", () => {
		expect(parseWorkFeed({ items: [] })).toBeNull();
		expect(parseWorkFeed({ hub: "x" })).toBeNull();
	});
});

function stubHub(opts: { seed: unknown; requireToken: boolean }) {
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const u = new URL(req.url);
			seen.push(`${u.pathname} ${req.headers.get("authorization") ?? "-"}`);
			if (opts.requireToken) {
				const auth = req.headers.get("authorization") ?? "";
				if (auth !== `Bearer ${TOKEN}`)
					return new Response(null, { status: 401 });
			}
			if (u.pathname === "/federation/work") return Response.json(opts.seed);
			return new Response(null, { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${String(server.port)}`,
		seen,
		close: () => server.stop(true),
	};
}

const TOKEN = "w370-edge-secret";

const RESOLVE_OK = (url: string) => async (label: string) => ({
	label,
	url,
	via: "test",
});

test.describe("pullFederatedWork", () => {
	test("seeded pull", async () => {
		const { env } = tmpEnv();
		const hub = stubHub({
			seed: {
				hub: "nas",
				generated_at: "t0",
				items: [
					{ id: "N1", title: "theirs", state: "CLAIMED", owner_sid: "s" },
				],
				total: 1,
				trunc: false,
			},
			requireToken: true,
		});
		const pullEnv = {
			...env,
			SUSPENDERS_FEDERATION_WORK_TOKEN: TOKEN,
		} as WorkEnv;
		const rows = await pullFederatedWork({
			labels: ["nas"],
			env: pullEnv,
			resolve: RESOLVE_OK(hub.url),
		});
		const r = rows[0];
		expect(r.ok).toBe(true);
		expect(r.seeded).toBe(true);
		expect(r.feed.items[0].id).toBe("N1");
		hub.close();
	});

	test("honest degrade keeps last-known on a downed hub", async () => {
		const { env } = tmpEnv();
		const seed = {
			hub: "nas",
			generated_at: "t0",
			items: [{ id: "N1", title: "theirs", state: "CLAIMED", owner_sid: "s" }],
			total: 1,
			trunc: false,
		};
		const hub = stubHub({ seed, requireToken: true });
		const pullEnv = {
			...env,
			SUSPENDERS_FEDERATION_WORK_TOKEN: TOKEN,
		} as WorkEnv;
		await pullFederatedWork({
			labels: ["nas"],
			env: pullEnv,
			resolve: RESOLVE_OK(hub.url),
		});
		hub.close();
		const rows = await pullFederatedWork({
			labels: ["nas"],
			env: pullEnv,
			resolve: RESOLVE_OK(hub.url),
			timeoutMs: 300,
		});
		const r = rows[0];
		expect(r.ok).toBe(false);
		expect(r.degraded).toBe(true);
		expect(r.feed.items[0].id).toBe("N1");
		expect(r.pulled_at).not.toBeNull();
	});
});

test.describe("workEdgeToken precedence", () => {
	test("per-label env > loc.token > shared env", () => {
		const env = {
			SUSPENDERS_HUB_NAS_TOKEN: "per-label",
			SUSPENDERS_FEDERATION_WORK_TOKEN: "shared",
		} as WorkEnv;
		expect(workEdgeToken("nas", null, env)).toBe("per-label");
		expect(
			workEdgeToken(
				"nas",
				{ label: "nas", url: "u", via: "v", token: "loc" },
				env,
			),
		).toBe("per-label");
		expect(
			workEdgeToken("nas", null, {
				SUSPENDERS_FEDERATION_WORK_TOKEN: "shared",
			} as WorkEnv),
		).toBe("shared");
		expect(workEdgeToken("nas", null, {} as WorkEnv)).toBeNull();
	});
});

test.describe("board serve + view routes", () => {
	test("/federation/work serves the local feed (fixture store)", async () => {
		const res = await handleFederationWork(
			new Request("http://b.local/federation/work"),
			new URL("http://b.local/federation/work"),
			fixtureStore(),
		);
		expect(res).not.toBeNull();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { hub: string; total: number };
		expect(body.hub.length).toBeGreaterThan(0);
		expect(body.total).toBe(3);
	});

	test("bearer required when SUSPENDERS_FEDERATION_WORK_TOKEN set", async () => {
		process.env.SUSPENDERS_FEDERATION_WORK_TOKEN = TOKEN;
		try {
			const bare = await handleFederationWork(
				new Request("http://b.local/federation/work"),
				new URL("http://b.local/federation/work"),
				fixtureStore(),
			);
			expect(bare.status).toBe(401);
			const good = await handleFederationWork(
				new Request("http://b.local/federation/work", {
					headers: { authorization: `Bearer ${TOKEN}` },
				}),
				new URL("http://b.local/federation/work"),
				fixtureStore(),
			);
			expect(good.status).toBe(200);
		} finally {
			delete process.env.SUSPENDERS_FEDERATION_WORK_TOKEN;
		}
	});

	test("/api/federation-work returns the whole view", async () => {
		const res = await handleFederationWork(
			new Request("http://b.local/api/federation-work"),
			new URL("http://b.local/api/federation-work"),
			fixtureStore(),
		);
		const body = (await res.json()) as {
			me: string;
			local: { total: number };
			peers: FedWorkRow[];
		};
		expect(body.local.total).toBe(3);
		expect(body.peers).toEqual([]);
	});
});

test.describe("federationWorkPage", () => {
	const view = {
		me: "lab",
		generated_at: "t0",
		local: {
			hub: "lab",
			generated_at: "t0",
			items: [
				{
					id: "W1",
					title: "a<b>",
					state: "READY",
					owner_sid: null,
					updated_at: 1,
				},
			],
			total: 1,
			trunc: false,
		},
		peers: [] as unknown[],
	};
	const html = federationWorkPage(
		view as unknown as Parameters<typeof federationWorkPage>[0],
	);
	test("page renders local scope + escaping", () => {
		expect(html).toContain("Federated work — me=lab");
		expect(html).toContain("a&lt;b&gt;");
	});
});

test.describe("page degraded edge section", () => {
	const dview = {
		me: "lab",
		generated_at: "t0",
		local: {
			hub: "lab",
			generated_at: "t0",
			items: [],
			total: 0,
			trunc: false,
		},
		peers: [
			{
				label: "nas",
				ok: false,
				degraded: true,
				seeded: false,
				reason: "resolve failed: boom",
				url: null,
				via: null,
				pulled_at: null,
				feed: null,
			},
		],
	};
	const dhtml = federationWorkPage(
		dview as unknown as Parameters<typeof federationWorkPage>[0],
	);
	test("degraded peer renders its honest reason", () => {
		expect(dhtml).toContain("nas — their work</h2>");
		expect(dhtml).toContain("degraded: resolve failed: boom");
	});
});

test.describe("e2e: pull rides the serve route", () => {
	test("lib pull ↔ board serve agree on the wire", async () => {
		const { env } = tmpEnv();
		const store = fixtureStore();
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const r = await handleFederationWork(req, new URL(req.url), store);
				return r ?? new Response(null, { status: 404 });
			},
		});
		const rows = await pullFederatedWork({
			labels: ["self"],
			env,
			resolve: async () => ({
				label: "self",
				url: `http://127.0.0.1:${String(server.port)}`,
				via: "test",
			}),
		});
		expect(rows[0].ok).toBe(true);
		expect(rows[0].feed.total).toBe(3);
		server.stop(true);
	});
});
