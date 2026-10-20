// usage-page.test.ts — W152: the rebuilt /usage dashboard — server-side
// team/dept filtering in buildUsageReport (facets stay unfiltered) + the
// page builder's render contract (uPlot vendored inline, payload columnar,
// chips compose, aids panel degrades honestly, LOCAL-ONLY hygiene).
// W652.3.1: panels live in the payload's `panels` slices — Lit renders them
// client-side, so tests assert payload shape + static hosts, not panel HTML.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-usage-page-"));
const { buildUsageReport } = await import(
	`../hooks/lib/usage.ts?home=${encodeURIComponent(HOME)}`
);
const { usagePage } = await import(
	`../hooks/bin/usage-page-html.ts?home=${encodeURIComponent(HOME)}`
);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

const ROLLUP_DDL =
	"CREATE TABLE usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))";
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, state TEXT NOT NULL DEFAULT 'R', started_at INTEGER NOT NULL, hb INTEGER NOT NULL, actor TEXT, tags TEXT)";

function freshDb(): Database {
	freshN += 1;
	const db = new Database(join(HOME, `scratch-${freshN}.db`), { create: true });
	db.run(ROLLUP_DDL);
	db.run(SESSIONS_DDL);
	return db;
}
let freshN = 0;

const H = 3_600_000;
const NOW = Date.parse("2026-10-01T12:20:00Z");
const TO = Math.floor(NOW / H) * H;
const b = (hoursAgo: number): number => TO - hoursAgo * H;

// W652.3.1: display-shaped panels slice the Lit components render.
type PanelSlice = {
	tiles?: { k: string; v: string }[];
	actors?: {
		rows: {
			actor: string;
			demo: boolean;
			chips: string[];
			segs: { g: string; tok: number }[];
			total: number;
			rq: number;
		}[];
	};
	aids?: {
		title?: string;
		empty?: string;
		rows?: {
			aid: string;
			domain: string;
			inj: number;
			skip: number;
			tok: number;
		}[];
	};
	activity?: { empty?: string };
};

type HeaderSlice = {
	teams: { label: string; href: string; on: boolean }[];
	depts: { label: string; href: string; on: boolean }[];
	filtered?: string;
};

/** Parse the embedded #usage-data payload's panels slice. */
const panelsOf = (html: string): PanelSlice => {
	const m = html.match(
		/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/,
	);
	return ((JSON.parse(m?.[1] ?? "{}") as { panels?: unknown }).panels ??
		{}) as PanelSlice;
};

function seed(db: Database): void {
	const ins = db.query(
		"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	// alice (platform/infra): flash-heavy; bob (apps/product): luna + local
	ins.run(b(2), "alice", "glm-5.3-flash", "flash", 1000, 500, 2000, 100, 5);
	ins.run(b(3), "alice", "claude-sonnet-5", "full", 200, 100, 0, 0, 1);
	ins.run(b(2), "bob", "luna-pro", "luna", 300, 150, 0, 0, 2);
	ins.run(b(26), "bob", "local-swarm", "local", 400, 200, 0, 0, 2);
	const sess = db.query(
		"INSERT INTO sessions (sid, started_at, hb, actor, tags) VALUES (?, ?, ?, ?, ?)",
	);
	sess.run("s1", 1, 1, "alice", '{"team":"platform","department":"infra"}');
	sess.run("s2", 2, 2, "bob", '{"team":"apps","department":"product"}');
}

describe("buildUsageReport filters (W152)", () => {
	test("one-hour drilldown keeps actor, model and tag attribution", () => {
		const db = freshDb();
		seed(db);
		const hour = buildUsageReport(db, {
			days: 0,
			nowMs: b(2),
			team: "platform",
		});
		expect(hour.fromBucket).toBe(b(2));
		expect(hour.toBucket).toBe(b(2));
		expect(hour.actors.map((actor) => actor.actor)).toEqual(["alice"]);
		expect(hour.actors[0].byModel.map((model) => model.model)).toEqual([
			"glm-5.3-flash",
		]);
		expect(hour.totals).toMatchObject({
			i: 1000,
			o: 500,
			cr: 2000,
			cc: 100,
			rq: 5,
		});
		db.close();
	});

	test("team filter cuts every series server-side", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, {
			days: 7,
			nowMs: NOW,
			team: "platform",
		});
		// alice only: (1000+200) in, (500+100) out, 2000 cache_r, 100 cache_c
		expect(r.totals).toEqual({
			i: 1200,
			o: 600,
			cr: 2000,
			cc: 100,
			rq: 6,
			tok: 3900,
		});
		expect(r.actors.map((a) => a.actor)).toEqual(["alice"]);
		const at = (hoursAgo: number): Record<string, number> =>
			r.timeline[Math.round((TO - hoursAgo * H - r.fromBucket) / H)].groups;
		expect(at(2).flash).toBe(3600);
		expect(at(2).luna).toBe(0); // bob's luna row is filtered out
		// facets come from the FULL tag universe — chips stay switchable
		expect(r.facets.teams).toEqual(["apps", "platform"]);
		expect(r.facets.depts).toEqual(["infra", "product"]);
		db.close();
	});

	test("dept filter composes; empty intersection is honest zeros", () => {
		const db = freshDb();
		seed(db);
		const prod = buildUsageReport(db, {
			days: 7,
			nowMs: NOW,
			dept: "product",
		});
		expect(prod.actors.map((a) => a.actor)).toEqual(["bob"]);
		const none = buildUsageReport(db, {
			days: 7,
			nowMs: NOW,
			team: "platform",
			dept: "product",
		});
		expect(none.actors).toEqual([]);
		expect(none.totals.tok).toBe(0);
		expect(none.timeline.every((p) => p.groups.flash === 0)).toBe(true);
		db.close();
	});
});

describe("usagePage render contract (W152)", () => {
	test("embeds payload, chips, vendored uPlot, shell; LOCAL-ONLY", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW, team: "platform" });
		const html = usagePage(r, { days: 7, team: "platform", dept: "" });
		const all = buildUsageReport(db, { days: 7, nowMs: NOW });
		expect(all.totals.tok).toBe(4950);
		expect(html).toContain("<klh-topbar");
		expect(html).toContain('src="/vendor/klh-topbar.js"');
		expect(html).toContain("var uPlot=function()");
		expect(html).toContain("box-sizing: border-box");
		// W658.4: chart panels ride the <klh-usage-charts> host — the ids now
		// live in the component's light-DOM render, not the server HTML
		expect(html).toContain("<klh-usage-charts");
		expect(html).not.toContain('id="u-timeline"');
		expect(html).not.toContain('id="u-hours"');
		expect(html).toContain('id="klh-theme-tokens"');
		expect(html).toContain("/vendor/usage-panels.js");
		expect(html).toContain("<klh-usage-tiles></klh-usage-tiles>");
		expect(html).toContain("<klh-usage-actors></klh-usage-actors>");
		expect(html).toContain("<klh-usage-aids></klh-usage-aids>");
		for (const section of [
			"overview",
			"actors",
			"cache",
			"sources",
			"activity",
		])
			expect(html).toContain(`id="${section}"`);
		const m = html.match(
			/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/,
		);
		expect(m).not.toBeNull();
		const p = JSON.parse(m?.[1] ?? "{}") as {
			groups: string[];
			timeline: number[][];
			byHour: number[][];
			slot: Record<string, string>;
			panels: PanelSlice;
		};
		expect(p.groups).toEqual(["flash", "full", "luna", "local", "other"]);
		expect(p.timeline.length).toBe(6);
		expect(p.timeline[0].length).toBe(r.timeline.length);
		expect(p.byHour.length).toBe(2);
		expect(p.slot.flash).toBe("#3987e5");
		// W652.3.1: panels ride the payload; Lit renders them client-side
		expect(p.panels.tiles?.map((t) => t.k)).toEqual([
			"ACTORS IN WINDOW",
			"TOTAL TOKENS",
			"REQUESTS",
			"MOST-USED MODEL",
			"OUTPUT TOK/S · LAST RECORDED HOUR (2026-10-01 10:00 UTC)",
		]);
		expect(p.panels.tiles?.[1]?.v).toBe("3.9K");
		expect(p.panels.actors?.rows.map((row) => row.actor)).toEqual(["alice"]);
		expect(p.panels.actors?.rows[0]?.chips).toEqual(["platform", "infra"]);
		expect(p.panels.actors?.rows[0]?.segs).toEqual([
			{ g: "flash", tok: 3600 },
			{ g: "full", tok: 300 },
		]);
		expect(p.panels.aids?.empty).toContain("no aid events yet");
		expect(p.panels.activity?.empty).toContain("meter not wired");
		db.close();
	});

	test("does not present an empty recent window as measured zero throughput", () => {
		const db = freshDb();
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		const tiles = panelsOf(usagePage(r, { days: 7 })).tiles ?? [];
		expect(tiles.at(-1)).toEqual({
			k: "OUTPUT TOK/S · NO RECENT USAGE",
			v: "—",
		});
		db.close();
	});
});

describe("usagePage chips + LOCAL-ONLY (W152)", () => {
	test("chips compose, actor table pre-filtered, no home paths leak", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW, team: "platform" });
		const html = usagePage(r, { days: 7, team: "platform", dept: "" });
		// W695.3.4: chips are the payload `header` slice (rendered by
		// <klh-usage-header>); hrefs are raw (Lit escapes on render)
		expect(html).toContain("<klh-usage-header></klh-usage-header>");
		const hdr = (
			JSON.parse(
				html.match(
					/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/,
				)?.[1] ?? "{}",
			) as { panels: { header: HeaderSlice } }
		).panels.header;
		expect(hdr.depts.map((c) => c.href)).toContain(
			"/usage?days=7&team=platform&dept=infra",
		);
		expect(hdr.teams.find((c) => c.on)?.label).toBe("platform");
		expect(hdr.filtered).toBe("dashboard filtered: team=platform");
		expect(html).toContain("alice");
		expect(html).not.toContain("bob<");
		expect(html).not.toContain("/Users/");
		db.close();
	});
});

describe("usagePage aids seam (W152)", () => {
	test("degrades honestly when empty, lights up when aids exist", () => {
		const db = freshDb();
		seed(db);
		const empty = panelsOf(
			usagePage(buildUsageReport(db, { days: 7, nowMs: NOW }), {
				days: 7,
			}),
		);
		expect(empty.aids?.empty).toContain("no aid events yet");
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		r.aids = {
			rollup: [
				{
					aid: "fleet-lessons",
					domain: "suspenders",
					injected: 12,
					skipped: 3,
					tok_injected: 4800,
				},
			],
			join: [
				{
					aid: "fleet-lessons",
					sid: "s1",
					work_item: "W152",
					actor: "alice",
					hour_bucket: b(2),
					tokens_injected: 400,
					in_tok: 1000,
					out_tok: 500,
				},
			],
		};
		const lit = panelsOf(usagePage(r, { days: 7 }));
		expect(lit.aids?.title).toBe("AID ROI · INJECTED VS SKIPPED");
		expect(lit.aids?.rows).toEqual([
			{
				aid: "fleet-lessons",
				domain: "suspenders",
				inj: 12,
				skip: 3,
				tok: 4800,
			},
		]);
		expect(lit.aids?.empty).toBeUndefined();
		db.close();
	});
});

describe("usagePage coverage evidence (W858.11)", () => {
	type CoverageSlice = {
		from: string;
		to: string;
		hoursTotal: number;
		hoursData: number;
		newest: string;
		newestAgeH: number;
		longestGapH: number;
		gapEnd: string;
		source: string;
		demoNote?: string;
		byDay: {
			d: string;
			hoursData: number;
			tok: number;
			href?: string;
		}[];
	};
	const coverageOf = (html: string): CoverageSlice => {
		const p = JSON.parse(
			html.match(
				/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/,
			)?.[1] ?? "{}",
		) as { panels: { coverage: CoverageSlice } };
		return p.panels.coverage;
	};

	test("coverage strip: window bounds, freshness, gap, provenance", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		const html = usagePage(r, { days: 7 });
		expect(html).toContain(
			"<klh-usage-tiles></klh-usage-tiles><klh-usage-charts></klh-usage-charts><klh-usage-coverage></klh-usage-coverage>",
		);
		const cov = coverageOf(html);
		expect(cov.from).toBe("2026-09-24 12:00 UTC");
		expect(cov.to).toBe("2026-10-01 12:00 UTC");
		expect(cov.hoursTotal).toBe(169);
		expect(cov.hoursData).toBe(3);
		expect(cov.newest).toBe("2026-10-01 10:00 UTC");
		expect(cov.newestAgeH).toBe(2);
		expect(cov.longestGapH).toBe(142);
		expect(cov.gapEnd).toBe("2026-09-30 09:00 UTC");
		expect(cov.source).toBe("legacy aggregate usage");
		// fixture has no demo/seed actors — the note is honestly omitted
		expect(cov.demoNote).toBeUndefined();
		db.close();
	});

	test("per-day drilldown rows carry first-live-hour hrefs", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		const cov = coverageOf(usagePage(r, { days: 7 }));
		const sep30 = cov.byDay.find((x) => x.d === "2026-09-30");
		expect(sep30?.hoursData).toBe(1);
		expect(sep30?.tok).toBe(600);
		expect(sep30?.href).toBe(`/usage?days=7&hour=${String(b(26))}#usage-hour`);
		const oct1 = cov.byDay.find((x) => x.d === "2026-10-01");
		expect(oct1?.hoursData).toBe(2);
		expect(oct1?.tok).toBe(4350);
		expect(oct1?.href).toBe(`/usage?days=7&hour=${String(b(3))}#usage-hour`);
		db.close();
	});

	test("drilldown hrefs preserve team filter state", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, {
			days: 7,
			nowMs: NOW,
			team: "platform",
		});
		const cov = coverageOf(usagePage(r, { days: 7, team: "platform" }));
		expect(cov.hoursData).toBe(2);
		const oct1 = cov.byDay.find((x) => x.d === "2026-10-01");
		expect(oct1?.href).toBe(
			`/usage?days=7&team=platform&hour=${String(b(3))}#usage-hour`,
		);
		db.close();
	});

	test("empty window: honest zeros, no newest, no drilldown hrefs", () => {
		const db = freshDb();
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		const cov = coverageOf(usagePage(r, { days: 7 }));
		expect(cov.hoursData).toBe(0);
		expect(cov.newest).toBe("");
		expect(cov.newestAgeH).toBe(-1);
		expect(cov.longestGapH).toBe(169);
		expect(cov.gapEnd).toBe("2026-10-01 12:00 UTC");
		expect(cov.byDay.every((x) => x.hoursData === 0 && !x.href)).toBe(true);
		db.close();
	});
});
