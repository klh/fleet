// test/hub-evidence@unit.e2e.ts — W2321.3: hub lane spend flows back onto
// the authoritative graph. Pins the hub-evidence module against the real
// /v1/admin/requests wire shape (stub hub via the kit's serveStub, keyset
// paging, lane+window filters, auth header) and the authority-side window
// replay (finalClaimWindow over a scratch governor store, latestStamp
// digest over the events bus).
// W2679 repair: page-1 rows ordered newest-first (the face's real
// ORDER BY ts DESC, rid DESC — the oldest row is the LAST element, so the
// keyset cursor r0 is well-defined); re_rid/before_rid asserted from the
// stub's recorded query strings; dead `u` construction gone; cross-page
// rid dedup pinned (a hub that ignores before_rid must not double-count).
import { serveStub, scratchWorld } from "@klh/test-kit";
import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	finalClaimWindow,
	hubLaneSpend,
	hubStampDigest,
	latestStamp,
} from "../hooks/lib/work/hub-evidence.ts";
import type { StubRequest } from "@klh/test-kit";

const w = scratchWorld({ prefix: "hub-evidence-" });
const GOV = join(w.home, ".cache", "claude-governor");
mkdirSync(GOV, { recursive: true });
const db = new Database(join(GOV, "governor.db"));
db.run("PRAGMA busy_timeout = 4500");
db.run(
	"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT, project TEXT)",
);
test.afterAll(() => {
	db.close();
	w.clean();
});

const PROJECT = "/tmp/hub-evidence-proj";
const now = Date.parse("2026-10-30T13:00:00Z");
const claimAt = now - 30 * 60_000;
const doneAt = now - 5 * 60_000;

const seedClaim = (work: string, sid: string): void => {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 't', 'work.claimed', NULL, ?, NULL, ?)",
	).run(claimAt, JSON.stringify({ work, project: PROJECT, by: sid }), PROJECT);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 't', 'work.done', NULL, ?, NULL, ?)",
	).run(doneAt, JSON.stringify({ work, project: PROJECT }), PROJECT);
};

test.describe("@unit", () => {
	test("hubLaneSpend pulls the lane window: pages, filters, auth, digests", async () => {
		let seen: StubRequest[] = [];
		const mkRow = (
			rid: string,
			ts: string,
			group: string,
			i: number,
			o: number,
			cr: number,
		): Record<string, unknown> => ({
			rid,
			ts,
			requested_group: group,
			in_tok: i,
			out_tok: o,
			cache_r: cr,
			cache_c: 0,
		});
		// two pages, newest-first like the real face (ORDER BY ts DESC, rid
		// DESC): page 1 holds r499..r0 (r0 = the LAST element = the oldest),
		// page 2 the older tail + one smuggled out-of-window row
		const page1 = Array.from({ length: 500 }, (_, k) =>
			mkRow(
				`r${499 - k}`,
				new Date(now - 10 * 60_000 + (499 - k)).toISOString(),
				"glm-5.3",
				10,
				2,
				3,
			),
		);
		const page2 = [
			mkRow(
				"r500",
				new Date(now - 25 * 60_000).toISOString(),
				"glm-5.3-flash",
				7,
				1,
				0,
			),
			// out-of-window row must be dropped even if the hub smuggles it
			mkRow(
				"r501",
				new Date(now - 3 * 86_400_000).toISOString(),
				"stale",
				999,
				999,
				999,
			),
		];
		const hub = serveStub((req, _body, n) => {
			const isSecond = n === 2;
			// a hub honoring the keyset contract never re-serves page 1
			if (isSecond && new URL(req.url).searchParams.get("before_rid") !== "r0")
				return Response.json({ requests: [] });
			return Response.json({ requests: isSecond ? page2 : page1 });
		});
		const res = await hubLaneSpend({
			base: hub.url,
			token: "bksk-test",
			lane: "autow2321-3",
			fromMs: claimAt,
			toMs: doneAt,
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const r = await fetch(input, init);
				seen = hub.requests;
				return r;
			}) as typeof fetch,
			maxPages: 3,
		});
		expect(res.reason).toBe("ok");
		expect(res.rows).toBe(502);
		expect(res.spend).not.toBeNull();
		const s = res.spend as {
			fresh: number;
			out: number;
			cached: number;
			requests: number;
			groups: Record<string, { in: number; out: number; requests: number }>;
		};
		expect(s.fresh).toBe(500 * 10 + 7);
		expect(s.out).toBe(500 * 2 + 1);
		expect(s.cached).toBe(500 * 3);
		expect(s.requests).toBe(501);
		expect(s.groups["glm-5.3"].in).toBe(5000);
		expect(s.groups["glm-5.3-flash"].in).toBe(7);
		expect(s.groups.stale).toBeUndefined();
		// the wire asked lane + window + cursor, with the bearer token
		expect(seen.length).toBe(2);
		expect(seen[0].auth).toBe("Bearer bksk-test");
		const q = (r: StubRequest): URLSearchParams => new URL(r.url).searchParams;
		expect(q(seen[0]).get("lane")).toBe("autow2321-3");
		expect(q(seen[0]).get("since")).toBe(new Date(claimAt).toISOString());
		expect(q(seen[0]).get("until")).toBe(new Date(doneAt).toISOString());
		expect(q(seen[0]).get("before_rid")).toBeNull();
		// keyset cursor: page 2 carries page 1's OLDEST rid (newest-first)
		expect(q(seen[1]).get("before_rid")).toBe("r0");
		hub.close();
	});

	test("cross-page rid dedup: a hub ignoring before_rid counts each rid once", async () => {
		// full page served identically on every fetch — without the dedup
		// guard the same 500 rows double-count into the spend
		const dup = Array.from({ length: 500 }, (_, k) => ({
			rid: `d${k}`,
			ts: new Date(now - 10 * 60_000 + k).toISOString(),
			requested_group: "glm-5.3",
			in_tok: 10,
			out_tok: 2,
			cache_r: 3,
			cache_c: 0,
		}));
		const hub = serveStub(() => Response.json({ requests: dup }));
		const res = await hubLaneSpend({
			base: hub.url,
			lane: "x",
			fromMs: claimAt,
			toMs: doneAt,
			maxPages: 5,
		});
		expect(res.reason).toBe("ok");
		// 500 unique rows — not 1000 (page 1) + the same 500 re-served
		expect(res.rows).toBe(500);
		const s = res.spend as { fresh: number; requests: number };
		expect(s.fresh).toBe(5000);
		expect(s.requests).toBe(500);
		hub.close();
	});

	test("malformed hub body degrades to honest no-data, never a hand-cast read", async () => {
		// schema law (W1238.4): a body that is not the W824 envelope parses
		// empty — no hand-cast rows, honest no-data
		const junk = serveStub(() => Response.json({ unexpected: true }));
		const r1 = await hubLaneSpend({
			base: junk.url,
			lane: "x",
			fromMs: claimAt,
			toMs: doneAt,
		});
		expect(r1.spend).toBeNull();
		expect(r1.reason).toBe("no rows in the claim window");
		junk.close();
		// row-level non-conformance (rid not a string, in_tok not a number)
		const bad = serveStub(() =>
			Response.json({
				requests: [
					{ rid: 1, ts: new Date(now - 60_000).toISOString(), in_tok: "x" },
				],
			}),
		);
		const r2 = await hubLaneSpend({
			base: bad.url,
			lane: "x",
			fromMs: claimAt,
			toMs: doneAt,
		});
		expect(r2.spend).toBeNull();
		expect(r2.reason).toBe("no rows in the claim window");
		bad.close();
	});

	test("empty window and HTTP failure degrade to honest no-data", async () => {
		const empty = serveStub(() => Response.json({ requests: [] }));
		const r1 = await hubLaneSpend({
			base: empty.url,
			lane: "x",
			fromMs: claimAt,
			toMs: doneAt,
		});
		expect(r1.spend).toBeNull();
		expect(r1.reason).toBe("no rows in the claim window");
		empty.close();
		const down = serveStub(() => new Response("no", { status: 503 }));
		const r2 = await hubLaneSpend({
			base: down.url,
			lane: "x",
			fromMs: claimAt,
			toMs: doneAt,
		});
		expect(r2.spend).toBeNull();
		expect(r2.reason).toContain("HTTP 503");
		down.close();
	});

	test("finalClaimWindow replays the last claim window from the bus", () => {
		seedClaim("W1", "lane-a");
		const win = finalClaimWindow(db, PROJECT, "W1", now);
		expect(win).toEqual({ sid: "lane-a", start: claimAt, end: doneAt });
		// never claimed → null, never invented
		expect(finalClaimWindow(db, PROJECT, "W9", now)).toBeNull();
		// an open claim runs to nowMs
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 't', 'work.claimed', NULL, ?, NULL, ?)",
		).run(
			now - 60_000,
			JSON.stringify({ work: "W2", project: PROJECT, by: "lane-b" }),
			PROJECT,
		);
		expect(finalClaimWindow(db, PROJECT, "W2", now)).toEqual({
			sid: "lane-b",
			start: now - 60_000,
			end: now,
		});
	});

	test("latestStamp reads the last work.attribution digest", () => {
		const spend = {
			fresh: 100,
			cached: 40,
			out: 20,
			requests: 3,
			groups: {},
		};
		const stamp = (hub: string | null): string =>
			JSON.stringify({
				work: "W1",
				project: PROJECT,
				backfill: JSON.stringify(spend),
				...(hub ? { hub } : {}),
			});
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 't', 'work.attribution', NULL, ?, NULL, ?)",
		).run(now, stamp("nas"), PROJECT);
		const got = latestStamp(db, PROJECT, "W1");
		expect(got?.hub).toBe("nas");
		expect(got?.digest).toBe(hubStampDigest(spend, "nas"));
		expect(latestStamp(db, PROJECT, "W404")).toBeNull();
	});

	test("runBackfillVerb --hub stamps the pull onto the bus", async () => {
		const hub = serveStub(() =>
			Response.json({
				requests: [
					{
						rid: "h1",
						ts: new Date(now - 15 * 60_000).toISOString(),
						requested_group: "glm-5.3",
						in_tok: 500,
						out_tok: 80,
						cache_r: 200,
						cache_c: 0,
					},
				],
			}),
		);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 't', 'work.claimed', NULL, ?, NULL, ?)",
		).run(
			claimAt,
			JSON.stringify({ work: "WH", project: PROJECT, by: "lane-h" }),
			PROJECT,
		);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 't', 'work.done', NULL, ?, NULL, ?)",
		).run(doneAt, JSON.stringify({ work: "WH", project: PROJECT }), PROJECT);
		let emitted: Record<string, string> | null = null;
		const { runBackfillVerb } = await import(
			"../hooks/lib/work/hub-evidence.ts"
		);
		const face = {
			base: hub.url,
			token: null,
		} as const;
		const origResolve = face;
		await runBackfillVerb(
			{
				store: db,
				project: PROJECT,
				get: (id) => (id === "WH" ? { state: "DONE" } : { state: "READY" }),
				completionRecord: () => ({ completed_by: "lane-h" }),
				backfillForItem: () => null,
				resolveBuckleDb: () => null,
				emit: (_k: string, _id: string, extra: Record<string, string>) => {
					emitted = extra;
				},
				log: () => {},
				green: (s: string) => s,
				cyan: (s: string) => s,
				die: (m: string) => {
					throw new Error(m);
				},
				hubFace: async () => origResolve,
			},
			"WH",
			(n: string) =>
				n === "--hub" ? "hub.test" : n === "--as" ? "lane-h" : null,
		);
		hub.close();
		expect(emitted).not.toBeNull();
		const stamp = emitted as unknown as { hub?: string; backfill?: string };
		expect(stamp.hub).toBe("hub.test");
		const spend = JSON.parse(stamp.backfill ?? "{}") as {
			fresh: number;
			cached: number;
		};
		expect(spend.fresh).toBe(500);
		expect(spend.cached).toBe(200);
	});
});
