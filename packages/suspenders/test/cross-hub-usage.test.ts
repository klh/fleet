// test/cross-hub-usage.test.ts — W365: the cross-hub usage rollup — hub
// enumeration (stack.yaml ∪ hubs.json), the pure per-hub wire rollup, the
// TTL-cached per-hub-degrade cycle, and the /usage page slice (rows for ok
// hubs, honest reason rows for down ones).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-crosshub-"));
const STACK = join(HOME, "stack.yaml");
const REGISTRY = join(HOME, "hubs.json");
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
	// the stack/registry loaders read process.env (STACK_PATH/REGISTRY_PATH)
	const p = process.env;
	prev.KLH_STACK = p.KLH_STACK;
	prev.SUSPENDERS_HUBS_FILE = p.SUSPENDERS_HUBS_FILE;
	p.KLH_STACK = STACK;
	p.SUSPENDERS_HUBS_FILE = REGISTRY;
	writeFileSync(
		STACK,
		[
			"hubs:",
			"  hub-a:",
			"    url: http://127.0.0.1:8501",
			"  hub-b:",
			"    url: http://127.0.0.1:8502",
			"  hub-c: {}",
			"",
		].join("\n"),
	);
	writeFileSync(
		REGISTRY,
		JSON.stringify({
			"hub-d": { candidates: ["http://127.0.0.1:8503"], token: "regtok" },
		}),
	);
});

afterAll(() => {
	if (prev.KLH_STACK === undefined) delete process.env.KLH_STACK;
	else process.env.KLH_STACK = prev.KLH_STACK;
	if (prev.SUSPENDERS_HUBS_FILE === undefined)
		delete process.env.SUSPENDERS_HUBS_FILE;
	else process.env.SUSPENDERS_HUBS_FILE = prev.SUSPENDERS_HUBS_FILE;
	rmSync(HOME, { recursive: true, force: true });
});

const env = (): Record<string, string> => ({
	HOME,
	KLH_STACK: STACK,
	SUSPENDERS_HUBS_FILE: REGISTRY,
});

// ─── enumeration + pure rollup + cycle ────────────────────────────────────
const lib = (): Promise<typeof import("../hooks/lib/cross-hub-usage.ts")> =>
	import(`../hooks/lib/cross-hub-usage.ts?home=${encodeURIComponent(HOME)}`);

describe("crossHubLabels", () => {
	test("unions stack.yaml hubs + hubs.json keys, deduped, sorted", async () => {
		const { crossHubLabels } = await lib();
		expect(crossHubLabels({ env: env() })).toEqual([
			"hub-a",
			"hub-b",
			"hub-c",
			"hub-d",
		]);
	});
});

describe("rollupHubWire", () => {
	test("sums windows per class + aids per (aid,domain)", async () => {
		const { rollupHubWire } = await lib();
		const out = rollupHubWire({
			spokes: 2,
			windows: [
				{
					bucket: 1,
					classes: {
						flash: {
							in_tok: 1000,
							out_tok: 400,
							cache_r: 60,
							cache_c: 5,
							requests: 7,
						},
						local: {
							in_tok: 200,
							out_tok: 90,
							cache_r: 0,
							cache_c: 0,
							requests: 2,
						},
					},
				},
			],
		});
		expect(out.spokes).toBe(2);
		expect(out.classes.flash.tok).toBe(1465);
		expect(out.classes.local.requests).toBe(2);
	});
});

describe("rollupHubWire aids", () => {
	test("folds aid rows per (aid,domain)", async () => {
		const { rollupHubWire } = await lib();
		const out = rollupHubWire({
			spokes: 0,
			windows: [],
			aids: [
				{
					aid: "lesson-recall",
					domain: "knowledge",
					injected: 4,
					skipped: 2,
					tok_injected: 1800,
				},
				{
					aid: "lesson-recall",
					domain: "knowledge",
					injected: 1,
					skipped: 0,
					tok_injected: 100,
				},
			],
		});
		expect(out.aids).toEqual([
			{
				aid: "lesson-recall",
				domain: "knowledge",
				injected: 5,
				skipped: 2,
				tok_injected: 1900,
			},
		]);
	});
});

describe("crossHubRollup", () => {
	const epA = {
		url: "http://127.0.0.1:8501",
		via: "stack.yaml",
		token: null,
	};
	const epB = {
		url: "http://127.0.0.1:8502",
		via: "stack.yaml",
		token: null,
	};
	const epD = {
		url: "http://127.0.0.1:8503",
		via: "hubs.json",
		token: "regtok",
	};
	// counts calls, answers ok only for the :8501 leg (hub-a)
	let calls = 0;
	const okOn8501 = async (
		url: string,
	): Promise<
		{ ok: true; wire: Record<string, unknown> } | { ok: false; why: string }
	> => {
		calls += 1;
		if (!url.includes("8501"))
			return { ok: false, why: "hub answered 503" };
		return {
			ok: true,
			wire: { ok: true, spokes: 1, windows: [], aids: [] },
		};
	};
	const endpoints = (l: string): unknown =>
		l === "hub-a"
			? [epA]
			: l === "hub-b"
				? [epB]
				: l === "hub-d"
					? [epD]
					: [];

	test("degrades per hub, summarizes ok hubs", async () => {
		const m = await lib();
		m.clearCrossHubTtl();
		const rep = await m.crossHubRollup({
			days: 7,
			env: env(),
			fetch: okOn8501,
			endpoints: endpoints as never,
		});
		const rows = Object.fromEntries(rep.rows.map((r) => [r.label, r]));
		expect(rows["hub-a"]?.ok).toBe(true);
		expect(rows["hub-a"]?.spokes).toBe(1);
		expect(rows["hub-b"]?.degraded).toBe(true);
		expect(rows["hub-b"]?.reason).toBe("hub answered 503");
		expect(rows["hub-c"]?.unresolved).toBe(true);
		expect(rows["hub-d"]?.degraded).toBe(true);
		expect(rep.summary.ok).toBe(1);
		expect(rep.summary.degraded).toBe(2);
		expect(rep.summary.unresolved).toBe(1);
	});

	test("TTL: cached rows are reused until ttlMs expires", async () => {
		const m = await lib();
		m.clearCrossHubTtl();
		calls = 0;
		const call = (): Promise<unknown> =>
			m.crossHubRollup({
				days: 7,
				env: env(),
				fetch: okOn8501,
				endpoints: endpoints as never,
			});
		const rep1 = await call();
		const rep2 = await call();
		expect(calls).toBe(3);
		const r1 = rep1 as { rows: Array<{ fetchedAt: string | null }> };
		const r2 = rep2 as { rows: Array<{ fetchedAt: string | null }> };
		expect(r2.rows[0]?.fetchedAt).toBe(r1.rows[0]?.fetchedAt);
		expect((rep1 as { summary: unknown }).summary.hubs).toBe(4);
	});
});

// ─── /usage page slice ────────────────────────────────────────────────────
describe("usagePage crosshub slice", () => {
	// minimal report cast — usagePage shapes slices, it never queries
	const fakeReport = {
		days: 7,
		fromBucket: 0,
		toBucket: 0,
		totals: { i: 0, o: 0, cr: 0, cc: 0, rq: 0, tok: 0 },
		timeline: [],
		byHour: [],
		actors: [],
		rate: { tokPerSec: 0, hourBucket: 0 },
		facets: { teams: [], depts: [] },
		demo: { included: false, excludedActors: 0 },
	} as never;
	const panelsOf = (html: string): Record<string, unknown> =>
		((JSON.parse(
			html.match(
				/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/,
			)?.[1] ?? "{}",
		) as { panels?: unknown }).panels ?? {}) as Record<string, unknown>;
	const row = (p: Record<string, unknown>): Record<string, unknown> => ({
		label: "x",
		ok: true,
		degraded: false,
		unresolved: false,
		quiet: false,
		reason: null,
		url: null,
		via: "stack.yaml",
		spokes: 0,
		classes: {},
		aids: [],
		fetchedAt: null,
		...p,
	});
	const FLASH = {
		in_tok: 1,
		out_tok: 2,
		cache_r: 3,
		cache_c: 4,
		requests: 5,
		tok: 10,
	};
	const summary = (n: number): Record<string, unknown> => ({
		hubs: n,
		ok: n - 1,
		degraded: 1,
		unresolved: 0,
		classes: {},
		aids: [],
	});

	test("ok hub rows + honest degrade rows ride the slice", async () => {
		const { usagePage } = await import(
			`../hooks/bin/usage-page-html.ts?home=${encodeURIComponent(HOME)}`
		);
		const crossHub = {
			days: 7,
			rows: [
				row({ label: "nas", spokes: 2, classes: { flash: FLASH } }),
				row({
					label: "desktop",
					ok: false,
					degraded: true,
					reason: "hub answered 503",
				}),
			],
			summary: summary(2),
		} as never;
		const html = usagePage(fakeReport, { days: 7, crossHub } as never);
		expect(html).toContain("<klh-usage-crosshub></klh-usage-crosshub>");
		const panels = panelsOf(html) as {
			crosshub?: {
				foot?: string;
				rows: Array<Record<string, unknown>>;
			};
		};
		expect(panels.crosshub?.rows[0]).toMatchObject({
			hub: "nas",
			total: 10,
			degraded: false,
		});
		expect(panels.crosshub?.rows[1]).toMatchObject({
			hub: "desktop",
			degraded: true,
			reason: "hub answered 503",
		});
		expect(panels.crosshub?.foot).toContain("1 reporting · 1 down");
	});

	test("degrades honestly when rollup absent", async () => {
		const { usagePage } = await import(
			`../hooks/bin/usage-page-html.ts?home=${encodeURIComponent(HOME)}`
		);
		const html = usagePage(fakeReport, { days: 7 } as never);
		const panels = panelsOf(html) as { crosshub?: { empty?: string } };
		expect(panels.crosshub?.empty).toContain("no hubs enumerated");
	});
});
