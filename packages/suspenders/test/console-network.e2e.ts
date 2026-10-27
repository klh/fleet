// console-network.test.ts — W858.10.3: the /console/buckle Network overview
// seam against a real board on a throwaway port: /api/console/network reads
// the seeded ledger + projection dbs (honest sections, no fabricated zeros),
// /console/buckle renders the klh-network-card host with the SSR seed, and
// /api/lane-routes stops 404ing once the projection db resolves.
import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveNetworkDbPaths } from "../../buckle/src/network-read-model.ts";
import { LaneProjection } from "../../buckle/src/projection.ts";

const HOME = mkdtempSync(join(tmpdir(), "w858net-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w858net-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const LEDGER = join(HOME, "buckle.db");
const OBS = join(HOME, "buckle-obs.db");

// minimal ledger schema + one settled usage-bearing route + one bucket
const led = new Database(LEDGER);
led.exec(`CREATE TABLE route_audit (
	rid TEXT PRIMARY KEY, ts TEXT, actor TEXT, lane TEXT, dialect TEXT,
	target_kind TEXT, target_host TEXT, target_port INTEGER, target_model TEXT,
	decision TEXT, status INTEGER, duration_ms INTEGER, ok INTEGER,
	in_tok INTEGER, out_tok INTEGER);
CREATE TABLE router_usage (
	hour_bucket TEXT PRIMARY KEY, in_tok INTEGER, out_tok INTEGER, requests INTEGER)`);
led.run(
	`INSERT INTO route_audit VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	"r1",
	new Date().toISOString(),
	"k1",
	"autow858",
	"openai",
	"cloud",
	"api.z.ai",
	null,
	"glm-5.3-flash",
	"route",
	200,
	120,
	1,
	100,
	500,
);
led.run(
	`INSERT INTO router_usage VALUES (?,?,?,?)`,
	`${new Date().toISOString().slice(0, 13)}:00:00`,
	100,
	500,
	1,
);
led.close();

// the REAL projection seeds itself (schema owned by the class) — one
// admitted+ended peer-forwarded edge on hub S1
const proj = new LaneProjection(OBS);
proj.ingest([
	{
		specversion: "1.0",
		type: "lane.request.admitted",
		source: "S1",
		id: "1",
		time: new Date().toISOString(),
		data: { rid: "a1", lane: "L1", peer: "nas" },
	},
	{
		specversion: "1.0",
		type: "lane.request.ended",
		source: "S1",
		id: "2",
		time: new Date().toISOString(),
		data: { rid: "a1", outcome: "ok", status: 200 },
	},
]);
proj.close();

// W1294.2.1: spawned stub belt observation feed on a scratch port — the
// board child's buckle read proxy + belt-asset probe both point here via
// SUSPENDERS_BELT_READ_ORIGIN (in-process serve can't answer a spawned
// child's loopback on this macOS). Serves the freshness chunk
// /dashboard-topology-hubs.js 200 (belt-up posture) and 404s the rest.
const BELT_PORT = 20000 + Math.floor(Math.random() * 20000);
const beltProc = Bun.spawn(
	[
		"bun",
		"-e",
		`Bun.serve({ port: ${BELT_PORT}, fetch: (req) => { const p = new URL(req.url).pathname; if (p === "/dashboard-topology-hubs.js") return new Response("export const hubsFresh = () => true;", { headers: { "content-type": "text/javascript" } }); return new Response("not found", { status: 404 }); } }); console.log("up"); setInterval(() => {}, 1e6);`,
	],
	{ stdout: "pipe", stderr: "pipe" },
);
// readiness: poll the stub's freshness chunk until it answers
for (let i = 0; ; i++) {
	try {
		if (
			(await fetch(`http://127.0.0.1:${BELT_PORT}/dashboard-topology-hubs.js`))
				.ok
		)
			break;
	} catch {}
	if (i > 100) throw new Error("stub belt feed did not start");
	await new Promise((r) => setTimeout(r, 100));
}

const env = {
	...process.env,
	HOME,
	BUCKLE_DB: LEDGER,
	KLH_LANE_ROUTES_DB: OBS,
	BELT_POLICY: join(HOME, "policy.yaml"),
	KLH_LOCAL_REGISTRY: join(HOME, "registry.json"),
	SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
	SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
	// W1294.2.1: the belt read origin pins to the stub asset feed above —
	// deterministic belt-up posture, no live :7791 fan-out from tests
	SUSPENDERS_BELT_READ_ORIGIN: `http://127.0.0.1:${BELT_PORT}`,
	SUSPENDERS_MDNS: "0",
	// W360 stub probes — deterministic tiles, no live loopback fan-out
	SUSPENDERS_PROBE_DEPS: "stub",
};

const bin = join(import.meta.dir, "..", "hooks", "bin");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const proc = Bun.spawn(
	["bun", join(bin, "fleet-board.ts"), "--port", String(PORT)],
	{
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	},
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${BASE}/api/data`)).ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error("network test board did not start");
}
await waitUp();

test.afterAll(async () => {
	proc.kill();
	await proc.exited;
	beltProc.kill();
	await beltProc.exited;
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

test.describe("resolveNetworkDbPaths precedence", () => {
	test("explicit knobs win, then PATH.db, then the HOME default", () => {
		expect(
			resolveNetworkDbPaths({
				BUCKLE_DB: "L",
				KLH_LANE_ROUTES_DB: "O",
				HOME: "/h",
			}),
		).toEqual({
			ledger: "L",
			obsDb: "O",
		});
		expect(
			resolveNetworkDbPaths({ BUCKLE_OBSERVATIONS_PATH: "/x/obs", HOME: "/h" }),
		).toEqual({
			ledger: "/h/.claude/local-llm/buckle.db",
			obsDb: "/x/obs.db",
		});
		expect(resolveNetworkDbPaths({})).toEqual({
			ledger: "buckle.db",
			obsDb: null,
		});
	});
});

test.describe("/api/console/network", () => {
	test("versioned topology endpoint reports observed, partial hop evidence", async () => {
		const res = await fetch(`${BASE}/api/console/topology`);
		expect(res.status).toBe(200);
		const topology = (await res.json()) as {
			ok: boolean;
			schemaVersion: number;
			totals: { requests: number };
			edges: Array<{ from: string; to: string; evidence: string }>;
		};
		expect(topology.ok).toBe(true);
		// W858.7.32 (056dbce4) bumped the wire to v2 (lane flows + measured
		// edges); the belt clients accept [1,2] — pin the CURRENT wire, not a
		// stale literal.
		expect(topology.schemaVersion).toBe(2);
		expect(topology.totals.requests).toBe(1);
		expect(topology.edges).toMatchObject([
			{
				id: "edge:nas->S1",
				from: "hub:nas",
				to: "hub:S1",
				requests: 1,
				lastSeenAt: expect.any(String),
				evidence: "peer",
			},
		]);
	});
	test("seeded dbs read through; nulls stay null, counts are real", async () => {
		const d = (await (await fetch(`${BASE}/api/console/network`)).json()) as {
			ok: boolean;
			ts: string;
			network: { ok: boolean } & Record<string, unknown>;
			gateway: unknown;
		};
		expect(d.ok).toBe(true);
		expect(d.network.ok).toBe(true);
		const n = d.network as {
			hubs: { source: string; requests: number; active: number }[];
			routes: { rid?: string }[];
			throughput: {
				window: { requests: number; in_tok: number | null };
				interfaces: { host: string; out60: number; req60: number }[];
			};
			hops: { peer: string }[];
		};
		expect(n.hubs).toHaveLength(1);
		expect(n.hubs[0]?.source).toBe("S1");
		expect(n.hubs[0]?.requests).toBe(1);
		// ended edge → TTL-bounded active is 0, not a phantom
		expect(n.hubs[0]?.active).toBe(0);
		expect(n.throughput.window.requests).toBe(1);
		expect(n.throughput.window.in_tok).toBe(100);
		expect(n.throughput.interfaces[0]?.host).toBe("api.z.ai");
		expect(n.throughput.interfaces[0]?.out60).toBe(500);
		expect(n.hops[0]?.peer).toBe("nas");
	});
});

test.describe("/console/buckle + /api/lane-routes", () => {
	test("legacy Belt console URL redirects to Buckle", async () => {
		const response = await fetch(`${BASE}/console/belt`, {
			redirect: "manual",
		});
		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe(`${BASE}/console/buckle`);
	});
	test("Buckle page carries the route summary card host + seed", async () => {
		const html = await (await fetch(`${BASE}/console/buckle`)).text();
		expect(html).toContain("klh-network-card");
		expect(html).toContain("Buckle route summary");
		expect(html).toContain("<belt-model-inventory>");
		expect(html).not.toContain("<belt-trends>");
		expect(html).toContain('id="modelaccess"');
		// W1294.2.1: the stub belt feed answers the freshness chunk, so the
		// page emits the full topology + model-access tag set
		expect(html).toContain("/console/buckle-assets/dashboard-model-access.js");
		expect(html).toContain("/console/buckle-assets/dashboard-topology-hubs.js");
		expect(html).not.toContain("<h2>belt API</h2>");
		expect(html).toContain("vendor/klh-console-cards.js");
	});

	test("lane-routes resolves the projection db (no more unset-knob 404)", async () => {
		const r = await fetch(`${BASE}/api/lane-routes`);
		expect(r.status).toBe(200);
		const d = (await r.json()) as { edges: unknown[] };
		expect(Array.isArray(d.edges)).toBe(true);
	});
});
