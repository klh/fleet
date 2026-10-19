// e2e/usage-panels-server.ts — W652.3.1: the bun side of the usage-panels
// e2e. Seeds a scratch sqlite db (same shape as test/usage-page.test.ts),
// renders BOTH dashboards through the REAL page builders, serves them plus
// the real /vendor bundles on an OS-picked loopback port, and writes the
// picked port to the port file given as argv[2]. Killed by the spec.
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUsageReport } from "../hooks/lib/usage.ts";
import { usagePage } from "../hooks/bin/usage-page-html.ts";
import { federationUsagePage } from "../hooks/bin/federation-usage-html.ts";
import { cacheDrillReport } from "../hooks/lib/cache-drill.ts";
import type { BuckleRequestRow as BuckleRow } from "../hooks/lib/cache-drill.ts";

const portFile = process.argv[2];
if (!portFile) throw new Error("usage: bun usage-panels-server.ts <portFile>");

const HOME = mkdtempSync(join(tmpdir(), "sb-e2e-usage-panels-"));
process.on("SIGTERM", () => {
	rmSync(HOME, { recursive: true, force: true });
	process.exit(0);
});

const db = new Database(join(HOME, "scratch.db"), { create: true });
db.run(
	"CREATE TABLE usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))",
);
db.run(
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, state TEXT NOT NULL DEFAULT 'R', started_at INTEGER NOT NULL, hb INTEGER NOT NULL, actor TEXT, tags TEXT)",
);
const H = 3_600_000;
const now = Math.floor(Date.now() / H) * H;
const roll = db.query(
	"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
// alice (platform/infra) flash-heavy, bob (apps/product) luna+local
roll.run(
	now - 2 * H,
	"alice",
	"glm-5.3-flash",
	"flash",
	1000,
	500,
	2000,
	100,
	5,
);
roll.run(now - 3 * H, "alice", "claude-sonnet-5", "full", 200, 100, 0, 0, 1);
roll.run(now - 2 * H, "bob", "luna-pro", "luna", 300, 150, 0, 0, 2);
roll.run(now - 26 * H, "bob", "local-swarm", "local", 400, 200, 0, 0, 2);
const sess = db.query(
	"INSERT INTO sessions (sid, started_at, hb, actor, tags) VALUES (?, ?, ?, ?, ?)",
);
sess.run("s1", 1, 1, "alice", '{"team":"platform","department":"infra"}');
sess.run("s2", 2, 2, "bob", '{"team":"apps","department":"product"}');

const report = buildUsageReport(db, { days: 7, nowMs: now });
// r.aids stays unset → the honest empty aids panel; activity stays unset →
// its honest empty. Both degrade paths are part of the look.
const usageHtml = usagePage(report, { days: 7 });
const fedHtml = federationUsagePage(
	{
		days: 28,
		spokes: 2,
		windows: [
			{
				bucket: now - 2 * H,
				team: "platform",
				spoke: "nas",
				classes: {
					flash: {
						in_tok: 4000,
						out_tok: 1500,
						cache_r: 400,
						cache_c: 40,
						requests: 12,
					},
					local: {
						in_tok: 900,
						out_tok: 300,
						cache_r: 0,
						cache_c: 0,
						requests: 3,
					},
				},
			},
			{
				bucket: now,
				team: "apps",
				spoke: "desktop",
				classes: {
					flash: {
						in_tok: 1500,
						out_tok: 600,
						cache_r: 100,
						cache_c: 10,
						requests: 5,
					},
				},
			},
		],
		aids: [
			{
				bucket: now,
				team: "platform",
				spoke: "nas",
				aid: "fleet-lessons",
				domain: "suspenders",
				injected: 12,
				skipped: 3,
				tok_injected: 4800,
			},
		],
	},
	{},
);
db.close();

// W825: canned cache-drill rows through parseRequestRow (sparse wire
// entries → honest nulls), one lane half-warm + a bare row. The lane param
// toggles the drilldown scope server-side.
import { parseRequestRow } from "../hooks/lib/cache-drill.ts";

const mk = (over: Record<string, unknown>): BuckleRow | null =>
	parseRequestRow({
		rid: "e2e-r1",
		ts: "2026-10-19T10:00:00Z",
		lane: "autow700",
		...over,
	});

const VENDOR = join(import.meta.dir, "..", "hooks/board-html/vendor");

const drillRows = [
	mk({
		rid: "e2e-r1",
		cache_r: 4000,
		target_model: "glm-5.3-flash",
		status: 200,
		ok: true,
		duration_ms: 120,
	}),
	mk({
		rid: "e2e-r2",
		ts: "2026-10-19T10:01:00Z",
		cache_r: 0,
		target_model: "glm-5.3-flash",
		status: 200,
		ok: true,
		duration_ms: 210,
	}),
	mk({
		rid: "e2e-r3",
		ts: "2026-10-19T10:02:00Z",
		cache_r: 0,
		target_model: "glm-5.3-flash",
		status: 200,
		ok: true,
		duration_ms: 190,
		in_tok: 90_000,
	}),
];

// The REAL lib over the canned rows (seams injected, no network): shapes
// aggregates, warm ratios and the miss-reason clusters the spec asserts on.
// Env fully isolated before any lib call: the stack path points nowhere and
// the fixture registry carries ONE label — the drill never reads the
// machine's real hub config (tryLoadStack reads process env).
process.env.KLH_STACK = "/nonexistent-w825-e2e-stack.yaml";
process.env.SUSPENDERS_HUBS_FILE = join(
	import.meta.dir,
	"w825-drill-hubs.json",
);
const drillFetch = async () => {
	const ok = drillRows.filter((r) => r !== null);
	return { ok: true, rows: ok };
};
const cannedDrill = await cacheDrillReport({
	days: 7,
	endpoints: () => [{ url: "http://canned/hub-a", via: "test", token: null }],
	fetch: drillFetch,
});

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.startsWith("/vendor/")) {
			try {
				return new Response(readFileSync(join(VENDOR, url.pathname.slice(8))), {
					headers: { "content-type": "text/javascript" },
				});
			} catch {
				return new Response("nope", { status: 404 });
			}
		}
		const page =
			url.pathname === "/usage"
				? usageHtml
				: url.pathname === "/federation-usage"
					? fedHtml
					: null;
		// W825: the drilldown API with canned rows — the lane param drives
		// the lane_scope (same contract the board route serves).
		if (url.pathname === "/api/usage/cache-drill") {
			const lane = url.searchParams.get("lane") ?? "";
			const scoped = lane
				? await cacheDrillReport({
						days: 7,
						endpoints: () => [
							{ url: "http://canned/hub-a", via: "test", token: null },
						],
						fetch: drillFetch,
						filters: { lane },
					})
				: cannedDrill;
			return Response.json(scoped);
		}
		if (page === null) return new Response("nope", { status: 404 });
		return new Response(page, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

// (canned drill data rides /api/usage/cache-drill below — see the W825
// block above)
await Bun.write(portFile, String(server.port));
console.log(`usage-panels-server up on :${String(server.port)}`);
