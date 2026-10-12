// test/cache-telemetry.test.ts — W458.4: per-lane cache telemetry wiring.
// A lane-attributed request appends one NDJSON row carrying the boundary
// it rode (origin-tenant for keyless upstreams, real usage columns); bare
// ingress appends nothing; the log reopens with the attribution intact
// (failover shape).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaneTelemetryLog, type LaneCacheRow } from "../src/cache-boundary.ts";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const CHAT_BODY = JSON.stringify({ model: "glm-5.3-flash" });

describe("per-lane cache telemetry (W458.4)", () => {
	test("lane-attributed requests append boundary rows", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "1",
				choices: [],
				usage: {
					prompt_tokens: 3,
					completion_tokens: 7,
					prompt_tokens_details: { cached_tokens: 5 },
				},
			}),
		);
		const dir = mkdtempSync(join(tmpdir(), "w4584-telemetry-"));
		const log = join(dir, "lane-cache.jsonl");
		const pool: UpstreamPool = {
			groups: () => ["glm-5.3-flash"],
			deployments: (g) => [
				{ group: g, url: upstream.url, dialect: "openai" as const },
			],
		};
		const d = {
			...testDeps(pool),
			laneCache: new LaneTelemetryLog(log),
		};
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/w/lane-t/v1/chat/completions`, {
				method: "POST",
				body: CHAT_BODY,
			}),
		);
		expect(res.status).toBe(200);
		const rows = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as LaneCacheRow);
		expect(rows.length).toBe(1);
		const r = rows[0];
		if (!r) throw new Error("no row");
		expect(r.lane).toBe("lane-t");
		expect(r.boundary.provider).toBe("openai");
		expect(r.boundary.tenant).toBe(new URL(upstream.url).origin);
		expect(r.boundary.model).toBe("glm-5.3-flash");
		expect(r.usage).toEqual({ in_tok: 3, out_tok: 7, cache_r: 5, cache_c: 0 });
		expect(r.requests).toBe(1);
		upstream.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("bare ingress appends nothing", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "1", choices: [], usage: { prompt_tokens: 3 } }),
		);
		const dir = mkdtempSync(join(tmpdir(), "w4584-telemetry-"));
		const log = join(dir, "lane-cache.jsonl");
		const pool: UpstreamPool = {
			groups: () => ["glm-5.3-flash"],
			deployments: (g) => [
				{ group: g, url: upstream.url, dialect: "openai" as const },
			],
		};
		const d = {
			...testDeps(pool),
			laneCache: new LaneTelemetryLog(log),
		};
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: CHAT_BODY,
			}),
		);
		expect(res.status).toBe(200);
		expect(await Bun.file(log).exists()).toBe(false);
		upstream.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
