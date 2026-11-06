// W2618 hub admission caps: the occupancy registry (acquire/release at the
// real settle, per-user/per-model/hub-total caps, tree-derived total,
// rolling gauges + sparkline ring) and the caps JSON env parse. Wire-level
// enforcement rides the ingress seam; the report face serves through
// GET /v1/admin/occupancy.
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { type MockUpstream, startMockUpstream } from "./mock.ts";
import {
	type AdmissionCaps,
	acquireOccupancy,
	capsFromEnv,
	derivedTotal,
	occupancyEnabled,
	occupancySnapshot,
	OccupancyReportSchema,
	releaseOccupancy,
	resetOccupancyForTest,
} from "../src/gov/occupancy.ts";

test.describe("@api", () => {
	test.describe("capsFromEnv", () => {
		test("absent or empty env = disabled", () => {
			expect(capsFromEnv({})).toBeNull();
			expect(capsFromEnv({ BUCKLE_ADMISSION_CAPS: "" })).toBeNull();
		});

		test("malformed JSON or schema drift = inert, never throws", () => {
			expect(capsFromEnv({ BUCKLE_ADMISSION_CAPS: "{nope" })).toBeNull();
			expect(
				capsFromEnv({ BUCKLE_ADMISSION_CAPS: '{"models":{"m":-1}}' }),
			).toBeNull();
			expect(
				capsFromEnv({ BUCKLE_ADMISSION_CAPS: '{"models":{"m":0}}' }),
			).toBeNull();
		});

		test("a valid doc parses; an empty doc stays disabled", () => {
			const caps = capsFromEnv({
				BUCKLE_ADMISSION_CAPS: '{"models":{"m":2},"users":{"k1":3}}',
			});
			expect(caps).toEqual({
				models: { m: 2 },
				users: { k1: 3 },
			});
			expect(capsFromEnv({ BUCKLE_ADMISSION_CAPS: "{}" })).toBeNull();
		});
	});

	test.describe("registry", () => {
		test("derived total sums the model caps", () => {
			const caps: AdmissionCaps = { models: { a: 4, b: 6 } };
			expect(derivedTotal(caps)).toBe(10);
			expect(derivedTotal({})).toBe(0);
		});

		test("disabled caps admit everything", () => {
			resetOccupancyForTest(null);
			expect(occupancyEnabled()).toBe(false);
			expect(acquireOccupancy("r0", "u", "m")).toBe(true);
		});

		test("per-model cap refuses at the bound; release admits again", () => {
			resetOccupancyForTest({ models: { m: 2 } });
			expect(occupancyEnabled()).toBe(true);
			expect(acquireOccupancy("r1", "u1", "m")).toBe(true);
			expect(acquireOccupancy("r2", "u2", "m")).toBe(true);
			expect(acquireOccupancy("r3", "u3", "m")).toBe(false);
			releaseOccupancy("r2");
			expect(acquireOccupancy("r3", "u3", "m")).toBe(true);
		});

		test("per-user cap (explicit row, then user_default) refuses at the bound", () => {
			resetOccupancyForTest({ user_default: 1, users: { vip: 2 } });
			expect(acquireOccupancy("u1a", "u1", "m")).toBe(true);
			expect(acquireOccupancy("u1b", "u1", "m")).toBe(false);
			expect(acquireOccupancy("v1a", "vip", "m")).toBe(true);
			expect(acquireOccupancy("v1b", "vip", "m")).toBe(true);
			expect(acquireOccupancy("v1c", "vip", "m")).toBe(false);
		});

		test("explicit hub_total caps overall admissions", () => {
			resetOccupancyForTest({ hub_total: 2, models: { m: 5 } });
			expect(acquireOccupancy("h1", "u1", "m")).toBe(true);
			expect(acquireOccupancy("h2", "u2", "m")).toBe(true);
			expect(acquireOccupancy("h3", "u3", "m")).toBe(false);
			releaseOccupancy("h1");
			expect(acquireOccupancy("h3", "u3", "m")).toBe(true);
		});
	});

	test.describe("report", () => {
		test("snapshot: per-model cards, per-user rows, totals vs derived max", () => {
			resetOccupancyForTest({ models: { m: 4, n: 2 }, users: { u1: 2 } });
			acquireOccupancy("s1", "u1", "m");
			acquireOccupancy("s2", "u1", "m");
			acquireOccupancy("s3", "u2", "n");
			const snap = occupancySnapshot("hub-x");
			expect(snap.enabled).toBe(true);
			expect(snap.derived_total).toBe(6);
			expect(snap.totals).toEqual({ current: 3, max: 6, basis: "derived" });
			expect(snap.models).toEqual([
				{
					model: "m",
					current: 2,
					max: 4,
					pct: 50,
					users: [{ user: "u1", current: 2, max: 2 }],
				},
				{
					model: "n",
					current: 1,
					max: 2,
					pct: 50,
					users: [{ user: "u2", current: 1, max: null }],
				},
			]);
			expect(snap.users).toEqual([
				{ user: "u1", current: 2, max: 2 },
				{ user: "u2", current: 1, max: null },
			]);
		});

		test("hub_total basis replaces the derived denominator", () => {
			resetOccupancyForTest({ hub_total: 9, models: { m: 4 } });
			acquireOccupancy("t1", "u", "m");
			const snap = occupancySnapshot("hub-y");
			expect(snap.totals).toEqual({ current: 1, max: 9, basis: "hub_total" });
		});

		// W2781: a CONFIGURED model with zero active admissions still renders
		// its 0/N utilization card — idle models used to vanish from the row
		// set (built from active admissions only), so the board showed nothing
		// for exactly the models an operator capped on purpose.
		test("idle configured models render a 0/N card", () => {
			resetOccupancyForTest({ models: { busy: 4, idle: 2 } });
			acquireOccupancy("i1", "u1", "busy");
			const snap = occupancySnapshot("hub-z");
			expect(snap.models).toEqual([
				{
					model: "busy",
					current: 1,
					max: 4,
					pct: 25,
					users: [{ user: "u1", current: 1, max: null }],
				},
				{ model: "idle", current: 0, max: 2, pct: 0, users: [] },
			]);
			// the row set unions active + configured, nothing else
			expect(snap.models.map((r) => r.model)).toEqual(["busy", "idle"]);
		});

		// W2781 schema-law face: the snapshot the endpoint serves parses
		// against the named OccupancyReportSchema (drift fails here first).
		test("occupancySnapshot output satisfies OccupancyReportSchema", () => {
			resetOccupancyForTest({ models: { m: 3 }, users: { u1: 2 } });
			acquireOccupancy("z1", "u1", "m");
			const parsed = OccupancyReportSchema.safeParse(occupancySnapshot("hub-s"));
			expect(parsed.success).toBe(true);
		});

		test("gauges count admissions in the last 1m/5m; release drops active", () => {
			resetOccupancyForTest({ models: { m: 10 } });
			acquireOccupancy("g1", "u", "m");
			releaseOccupancy("g1");
			const snap = occupancySnapshot("hub-z");
			expect(snap.gauges.active).toBe(0);
			expect(snap.gauges.admitted_1m).toBe(1);
			expect(snap.gauges.admitted_5m).toBe(1);
		});

		test("sparkline ring: one sample per period, bounded", () => {
			resetOccupancyForTest({ models: { m: 10 } });
			acquireOccupancy("p1", "u", "m");
			const first = occupancySnapshot("hub-p", 1_000_000);
			expect(first.samples.length).toBe(1);
			expect(first.samples[0]?.total).toBe(1);
			const second = occupancySnapshot("hub-p", 1_001_000);
			expect(second.samples.length).toBe(1); // inside the period — no growth
			const third = occupancySnapshot("hub-p", 1_031_000);
			expect(third.samples.length).toBe(2);
			expect(third.samples[1]?.by_model).toEqual({ m: 1 });
		});
	});

	test.describe("ingress enforcement (wire)", () => {
		const GROUP = "capgrp";

		function poolOf(deps: Array<Omit<Deployment, "group">>): UpstreamPool {
			return {
				groups: () => [GROUP],
				deployments: (g) =>
					g === GROUP ? deps.map((d) => ({ ...d, group: g })) : [],
			};
		}

		const req = (url: string, signal?: AbortSignal): Request =>
			new Request(`${url}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: GROUP,
					messages: [{ role: "user", content: "hi" }],
				}),
				signal,
			});

		const waitSettled = async (): Promise<void> => {
			for (let i = 0; i < 40; i++) {
				if (occupancySnapshot("t").gauges.active === 0) return;
				await Bun.sleep(50);
			}
		};

		test("a full cap refuses at ingress with zero outbound; release admits", async () => {
			resetOccupancyForTest({ user_default: 1, models: { [GROUP]: 5 } });
			let up: MockUpstream | null = null;
			try {
				up = await startMockUpstream(() =>
					Response.json({ choices: [{ message: { content: "ok" } }] }),
				);
				const app = createApp(
					testDeps(poolOf([{ url: up.url, dialect: "openai" }]), {}),
				);
				// tokenless ingress keys as "" — fill the user's single seat
				expect(acquireOccupancy("preset", "", GROUP)).toBe(true);
				const r1 = await app.fetch(req("http://buckle.test"));
				expect(r1.status).toBe(429);
				const body = (await r1.json()) as { code?: string };
				expect(body.code).toBe("buckle.occupancy_cap");
				expect(up.calls.length).toBe(0); // refused before any routing
				releaseOccupancy("preset");
				const r2 = await app.fetch(req("http://buckle.test"));
				expect(r2.status).toBe(200);
				// the settle released the admission
				await waitSettled();
				expect(occupancySnapshot("t").gauges.active).toBe(0);
			} finally {
				resetOccupancyForTest(null);
				up?.close();
			}
		});
	});
});
