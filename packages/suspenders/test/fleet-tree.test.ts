// W530.2 — fleet tree refresh semantics: single-flight coalescing, bounded
// parallel probes, up/down transitions, last-good on inaccessible registry,
// scenario-only (demo) roots never reaching routing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTreeSource,
	handleFleetTree,
	type TreeDeps,
} from "../hooks/board/routes-fleet-tree.ts";
import { resolveHub } from "../hooks/lib/hub-locate.ts";

type Row = Record<string, unknown>;
type Scenario = {
	registryOk: boolean;
	upLeaves: Set<string>;
	seen: {
		registry: number;
		inflight: number;
		maxInflight: number;
		urls: string[];
	};
	latencyMs?: number;
};

const stubDeps = (home: string, registry: string, s: Scenario): TreeDeps => ({
	fetchImpl: (async (url: string | URL | Request) => {
		const u = String(url);
		s.seen.urls.push(u);
		// the hub candidate gets its OWN doc: leaves ride port 5999 on the hub
		// host — the W530.2 origin fix makes probes hit :5999, never :5999:5999
		if (u === "http://127.0.0.1:5999/registry.json" && s.registryOk)
			return new Response(
				JSON.stringify({
					router: { port: 5999 },
					entries: [
						{
							alias: "nas-coder",
							label: "nas-coder",
							port: 5999,
							tier: "coder",
						},
					],
				}),
				{ status: 200 },
			);
		if (u.endsWith("/registry.json")) {
			s.seen.registry++;
			if (s.latencyMs) await new Promise((r) => setTimeout(r, s.latencyMs));
			if (!s.registryOk) throw new Error("unreachable");
			return new Response(
				JSON.stringify({
					router: { port: 4001 },
					entries: [
						{ alias: "coder", label: "coder", port: 4001, tier: "coder" },
						{ alias: "reason", label: "reason", port: 4002, tier: "reason" },
						{ alias: "danish", label: "danish", port: 4003, tier: "danish" },
						{ alias: "vision", label: "vision", port: 4004, tier: "vision" },
						{ alias: "extract", label: "extract", port: 4005, tier: "extract" },
						{
							alias: "cloudy",
							label: "cloudy",
							port: 0,
							tier: "cloud",
							external: true,
						},
					],
				}),
				{ status: 200 },
			);
		}
		// leaf probe — latency so the bounded pool can overlap
		if (s.latencyMs) await new Promise((r) => setTimeout(r, s.latencyMs));
		if (s.upLeaves.has(u)) return new Response("{}", { status: 200 });
		throw new Error("connection refused");
	}) as typeof fetch,
	now: () => Date.now(),
	llmHome: () => home,
	localRegistry: () => registry,
	probeLimit: 2,
	probeTimeoutMs: 700,
	registryTimeoutMs: 2000,
});

const home = mkdtempSync(join(tmpdir(), "w5302-"));
mkdirSync(home, { recursive: true });
const writeHome = (hubs: unknown, demo: unknown): void => {
	writeFileSync(join(home, "hubs.json"), JSON.stringify(hubs));
	writeFileSync(join(home, "hubs-demo.json"), JSON.stringify(demo));
};
const HUBS = { nas: { candidates: ["http://127.0.0.1:5999"] } };
const DEMO = {
	"demo-hub": { note: "scenario", models: [{ label: "m1", up: null }] },
};

describe("W530.2 fleet tree refresh", () => {
	test("concurrent misses coalesce into ONE sweep (no stampede)", async () => {
		writeHome({}, DEMO);
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set(["u"]),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
		};
		const src = createTreeSource(stubDeps(home, "http://127.0.0.1:4000", s));
		const [a, b] = await Promise.all([src.tree(true), src.tree(true)]);
		expect(s.seen.registry).toBe(1);
		expect(a).toBe(b); // same snapshot object — one sweep, both callers
	});

	test("leaf probes fan out bounded (never past probeLimit at once)", async () => {
		writeHome({}, DEMO);
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set(),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
			latencyMs: 15,
		};
		const raw = stubDeps(home, "http://127.0.0.1:4000", s);
		const deps: TreeDeps = {
			...raw,
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				s.seen.inflight++;
				s.seen.maxInflight = Math.max(s.seen.maxInflight, s.seen.inflight);
				try {
					return await raw.fetchImpl(url, init);
				} finally {
					s.seen.inflight--;
				}
			}) as typeof fetch,
		};
		const src = createTreeSource(deps);
		const snap = await src.tree(true);
		const leaves = snap.tree[0].models;
		expect(leaves.length).toBe(7); // router + 6 entries
		expect(s.seen.maxInflight).toBeLessThanOrEqual(2);
		expect(s.seen.maxInflight).toBe(2); // 7 probes DO saturate the pool
		const ups = leaves.filter((m: Row) => m.up === true).length;
		expect(ups).toBe(0); // upLeaves empty — every probeable leaf down
	});

	test("lane stop/start transition flips the leaf on the next sweep", async () => {
		writeHome({}, DEMO);
		const coderUrl = "http://127.0.0.1:4001/v1/models";
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set([coderUrl]),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
		};
		const src = createTreeSource(stubDeps(home, "http://127.0.0.1:4000", s));
		const before = await src.tree(true);
		expect(
			before.tree[0].models.find((m: Row) => m.label.includes("coder"))?.up,
		).toBe(true);
		s.upLeaves.delete(coderUrl); // lane stops answering
		const after = await src.tree(true);
		expect(
			after.tree[0].models.find((m: Row) => m.label.includes("coder"))?.up,
		).toBe(false);
		s.upLeaves.add(coderUrl); // lane starts again
		const again = await src.tree(true);
		expect(
			again.tree[0].models.find((m: Row) => m.label.includes("coder"))?.up,
		).toBe(true);
	});

	test("inaccessible registry: last-good snapshot served stale", async () => {
		writeHome(HUBS, DEMO);
		let t = 1_000;
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set(["u"]),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
		};
		const raw = stubDeps(home, "http://127.0.0.1:4000", s);
		const deps: TreeDeps = { ...raw, now: () => (t += 1000) };
		const src = createTreeSource(deps);
		const good = await src.tree(true);
		expect(good.stale).toBeUndefined();
		s.registryOk = false; // registry disappears
		const stale = await src.tree(true);
		expect(stale.stale).toBe(true);
		expect(stale.generated_at).toBe(good.generated_at);
		// the stale view IS the last good tree — local was fine moments ago
		expect(stale.tree[0].down).toBeUndefined();
		expect(stale.tree.some((r: Row) => r.demo === true)).toBe(true);
	});

	test("failed refresh caches the same stale fallback for ordinary and concurrent callers", async () => {
		writeHome({}, DEMO);
		let now = 1_000;
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set(),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
			latencyMs: 10,
		};
		const deps = stubDeps(home, "http://127.0.0.1:4000", s);
		const src = createTreeSource({ ...deps, now: () => now });
		const good = await src.tree();
		now = 2_000;
		s.registryOk = false;
		const [forced, concurrent, ordinaryDuringRefresh] = await Promise.all([
			src.tree(true),
			src.tree(true),
			src.tree(),
		]);
		expect(forced.stale).toBe(true);
		expect(forced.generated_at).toBe(good.generated_at);
		expect(forced.tree).toBe(good.tree);
		expect(concurrent).toBe(forced);
		expect(ordinaryDuringRefresh).toBe(forced);
		const [cached, anotherCached] = await Promise.all([src.tree(), src.tree()]);
		expect(cached).toBe(forced);
		expect(anotherCached).toBe(forced);
		expect(s.seen.registry).toBe(2);
		now = 33_000;
		s.registryOk = true;
		const recovered = await src.tree();
		expect(recovered.stale).toBeUndefined();
		expect(recovered.generated_at).not.toBe(good.generated_at);
		expect(await src.tree()).toBe(recovered);
	});

	test("no last good yet: registry down serves the honest all-down view", async () => {
		writeHome(HUBS, DEMO);
		const s: Scenario = {
			registryOk: false,
			upLeaves: new Set<string>(),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
		};
		const src = createTreeSource(stubDeps(home, "http://127.0.0.1:4000", s));
		const snap = await src.tree(true);
		expect(snap.stale).toBeUndefined();
		expect(snap.tree[0].down).toBe(true);
		expect(snap.generated_at).toBeTruthy();
		expect(snap.tree.some((r: Row) => r.demo === true)).toBe(true);
	});

	test("scenario-only roots stay display-only: demo:true on wire, invisible to routing", async () => {
		writeHome(HUBS, DEMO);
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set<string>(),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
		};
		const src = createTreeSource(stubDeps(home, "http://127.0.0.1:4000", s));
		const snap = await src.tree(true);
		const demoRoot = snap.tree.find((r: Row) => r.demo === true);
		expect(demoRoot?.label).toBe("demo-hub");
	});

	test("routing cannot resolve a scenario-only label (hubs-demo.json is invisible to resolveHub)", async () => {
		const reg = mkdtempSync(join(tmpdir(), "w5302-reg-"));
		const regFile = join(reg, "hubs.json");
		writeFileSync(
			regFile,
			JSON.stringify({ other: { candidates: ["http://127.0.0.1:5998"] } }),
		);
		const prev = process.env.SUSPENDERS_HUBS_FILE;
		process.env.SUSPENDERS_HUBS_FILE = regFile;
		try {
			const loc = await resolveHub("ghost-demo-hub");
			expect(loc).toBeNull();
		} finally {
			process.env.SUSPENDERS_HUBS_FILE = prev;
		}
		rmSync(reg, { recursive: true, force: true });
	}, 20000);

	test("handler wire: snapshot fields, manual ?refresh=1, page chrome", async () => {
		writeHome({}, DEMO);
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set<string>(),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
		};
		const src = createTreeSource(stubDeps(home, "http://127.0.0.1:4000", s));
		const get = (u: string) => handleFleetTree(new Request(u), new URL(u), src);
		const api = await get("http://b/api/fleet-tree");
		const wire = (await api.json()) as Row;
		expect(wire.tree.length).toBeGreaterThan(0);
		expect(wire.generated_at).toBeTruthy();
		await get("http://b/api/fleet-tree?refresh=1");
		expect(s.seen.registry).toBe(2); // ?refresh=1 bypassed the TTL
		const page = await get("http://b/fleet-tree");
		const html = await page.text();
		expect(html).toContain('id="refresh"');
		expect(html).toContain("refresh=1");
		expect(html).toContain("visibilitychange");
	}, 10000);

	test("hub leaves probe the candidate HOST with the registry PORT", async () => {
		writeHome(HUBS, DEMO);
		const s: Scenario = {
			registryOk: true,
			upLeaves: new Set<string>(["http://127.0.0.1:5999/v1/models"]),
			seen: { registry: 0, inflight: 0, maxInflight: 0, urls: [] },
		};
		const src = createTreeSource(stubDeps(home, "http://127.0.0.1:4000", s));
		const snap = await src.tree(true);
		const hub = snap.tree.find((r: Row) => r.label === "nas");
		expect(hub?.models.length).toBe(2); // router + one entry, both :5999
		expect(hub?.models.every((m: Row) => m.up === true)).toBe(true);
		expect(s.seen.urls).toContain("http://127.0.0.1:5999/v1/models");
		expect(s.seen.urls).not.toContain("http://127.0.0.1:5999:5999/v1/models");
	}, 10000);
});
