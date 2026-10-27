// setup-cache.test.ts — W852: the setup checklist rides a stale-while-revalidate
// cache; the page seeds from the SAME snapshot (no loading flash), and the
// advice-LLM check is tier-aware (BELT_TIER=minimal fleets with the advice
// target on demand stay ok while a resident swarm port answers). Integration
// tier: real board on an OS-chosen port, scratch HOME, fixture endpoints.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

// W852 fixture: the tier manifest + hub registry are machine config read at
// REQUEST time — pointed at a temp dir with a live fixture endpoint. The env
// pins ride process.env (boardFixture spreads it) and are removed in
// test.afterAll so no other test file inherits them.
const cfgDir = mkdtempSync(join(tmpdir(), "suspenders-setupcache-"));
const manifestPath = join(cfgDir, "tier.json");
const hubsPath = join(cfgDir, "hubs.json");
process.env.BELT_TIER = "minimal";
process.env.BELT_TIER_MANIFEST = manifestPath;
process.env.SUSPENDERS_HUBS_FILE = hubsPath;

// fixture endpoint: answers /v1/models (the tier-aware LLM probe) and
// /api/health (the hub probe) with 200
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response("ok", { status: 200 }),
});
writeFileSync(
	manifestPath,
	`${JSON.stringify({ version: 1, tier: "minimal", warm_ports: [upstream.port] }, null, "\t")}\n`,
);
writeFileSync(
	hubsPath,
	`${JSON.stringify({ nas: { candidates: [`http://127.0.0.1:${upstream.port}`] } }, null, "\t")}\n`,
);

const { BASE } = await boardFixture(0, test.afterAll);

test.afterAll(() => {
	upstream.stop(true);
	delete process.env.BELT_TIER;
	delete process.env.BELT_TIER_MANIFEST;
	delete process.env.SUSPENDERS_HUBS_FILE;
	rmSync(cfgDir, { recursive: true, force: true });
});

test.describe("W852 setup cache + tier-aware advice check", () => {
	test("/api/setup: minimal tier + dead advice origin + live resident = on-demand ok", async () => {
		const r = await (await fetch(`${BASE}/api/setup`)).json();
		expect(r.ok).toBe(true);
		const byId = Object.fromEntries(
			r.checks.map((c: Record<string, unknown>) => [c.id, c]),
		);
		expect(byId.llm.ok).toBe(true);
		expect(String(byId.llm.detail)).toContain("on-demand");
		expect(String(byId.llm.detail)).toContain(String(upstream.port));
		expect(byId.hubs.ok).toBe(true);
		expect(String(byId.hubs.detail)).toContain("answers");
	});

	test("GET / seeds the checklist — the page opens with data, no loading flash", async () => {
		const html = await (await fetch(`${BASE}/`)).text();
		const seed = html.match(/window\.__SETUP__=(\{.*?\})<\/script>/);
		expect(seed?.[1]).toBeTypeOf("string");
		if (typeof seed?.[1] !== "string") return;
		const j = JSON.parse(seed[1].replaceAll("\\u003c", "<"));
		expect(j.ok).toBe(true);
		expect(j.ts).toBeGreaterThan(0);
		expect(j.checks.map((c: Record<string, unknown>) => c.id)).toContain(
			"hubs",
		);
		// the static template still carries the placeholder, replaced per request
		expect(html.includes("/*SETUP_SEED*/")).toBe(false);
	});

	test("cached feed: repeat fetch is the same snapshot until the TTL passes", async () => {
		const a = await (await fetch(`${BASE}/api/setup`)).json();
		const b = await (await fetch(`${BASE}/api/setup`)).json();
		expect(b.ts).toBe(a.ts);
	});
});
