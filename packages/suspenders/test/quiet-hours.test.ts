// test/quiet-hours.test.ts — W483: stack.yaml `quiet_hours` — the NAS hub
// is EXPECTED dark in its nightly poweroff window. Covers the parser (incl.
// midnight-crossing windows), the per-hub and per-URL lookups, the
// metrics-alert scrape skip, and resolveHub's dark-hub degradation.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	darkHubNow,
	inQuietHours,
	parseQuietHours,
	urlInQuietHours,
} from "../hooks/lib/stack-config.ts";
import {
	skipQuietTarget,
	type AlertState,
} from "../hooks/bin/metrics-alert.ts";
import { resolveHub } from "../hooks/lib/hub-locate.ts";

const home = mkdtempSync(join(tmpdir(), "suspenders-quiet-hours-test-"));
const STACK = join(home, "stack.yaml");
const at = (h: number, m = 0): Date => new Date(2026, 9, 7, h, m);

const writeStack = (yaml: string): void => writeFileSync(STACK, yaml);
const stackEnv = (hubs: string): void => {
	process.env.KLH_STACK = STACK;
	writeStack(`hubs:\n${hubs}`);
};

describe("parseQuietHours", () => {
	test("parses a plain window and a midnight-crossing one", () => {
		expect(parseQuietHours("00:00-08:00")).toEqual({ start: 0, end: 480 });
		expect(parseQuietHours("23:30-07:15")).toEqual({ start: 1410, end: 435 });
	});
	test("rejects malformed, out-of-range and degenerate specs", () => {
		expect(parseQuietHours("24:00-08:00")).toBeNull();
		expect(parseQuietHours("00:60-08:00")).toBeNull();
		expect(parseQuietHours("08:00-08:00")).toBeNull();
		expect(parseQuietHours("8-9")).toBeNull();
		expect(parseQuietHours("")).toBeNull();
	});
});

describe("inQuietHours", () => {
	test("inside and outside a plain window", () => {
		const hub = { quiet_hours: "00:00-08:00" };
		expect(inQuietHours(hub, at(3))).toBe(true);
		expect(inQuietHours(hub, at(7, 59))).toBe(true);
		expect(inQuietHours(hub, at(8))).toBe(false);
		expect(inQuietHours(hub, at(23))).toBe(false);
	});
	test("a window crossing midnight wraps", () => {
		const hub = { quiet_hours: "23:00-08:00" };
		expect(inQuietHours(hub, at(23, 30))).toBe(true);
		expect(inQuietHours(hub, at(3))).toBe(true);
		expect(inQuietHours(hub, at(12))).toBe(false);
	});
	test("no spec (or garbage) is never quiet — config-over-code", () => {
		expect(inQuietHours({}, at(3))).toBe(false);
		expect(inQuietHours({ quiet_hours: "nonsense" }, at(3))).toBe(false);
	});
});

describe("darkHubNow", () => {
	test("label match is case-insensitive; unknown label = awake", () => {
		stackEnv(`  nas:
    host: nas.threads.dk
    quiet_hours: "00:00-08:00"`);
		expect(darkHubNow("NAS", at(3))).toBe(true);
		expect(darkHubNow("nas", at(12))).toBe(false);
		expect(darkHubNow("desktop", at(3))).toBe(false);
	});
	test("missing/unreadable stack = false, never throws", () => {
		process.env.KLH_STACK = join(home, "nope.yaml");
		expect(darkHubNow("nas", at(3))).toBe(false);
	});
});

describe("urlInQuietHours", () => {
	test("hostname match suppresses; ssh user stripped from stack host", () => {
		stackEnv(`  nas:
    host: kk@nas.threads.dk
    quiet_hours: "00:00-08:00"`);
		expect(urlInQuietHours("http://nas.threads.dk:4101", at(3))).toBe(true);
		expect(urlInQuietHours("http://nas.threads.dk:4101", at(12))).toBe(false);
		expect(urlInQuietHours("http://desktop.local:4101", at(3))).toBe(false);
		expect(urlInQuietHours("not a url", at(3))).toBe(false);
	});
});

describe("skipQuietTarget (metrics-alert)", () => {
	test("quiet target skipped with misses forgiven; awake target scraped", () => {
		stackEnv(`  nas:
    host: nas.threads.dk
    quiet_hours: "00:00-08:00"`);
		const state: AlertState = {
			targets: {
				"http://nas.threads.dk:4101": {
					url: "http://nas.threads.dk:4101",
					misses: 1,
					lastOkAt: null,
					series: [],
					active: {},
				},
			},
		};
		expect(skipQuietTarget(state, "http://nas.threads.dk:4101", at(3))).toBe(
			true,
		);
		expect(state.targets["http://nas.threads.dk:4101"]?.misses).toBe(0);
		expect(skipQuietTarget(state, "http://127.0.0.1:7799", at(3))).toBe(false);
	});
});

describe("resolveHub quiet-hours degradation", () => {
	test("a dark hub resolves to null before any probing", async () => {
		// resolveHub has no clock seam — build a window around REAL now
		// (±60min; fmt() normalizes mod 1440 so wrap windows work too)
		const fmt = (m: number): string => {
			const n = ((m % 1440) + 1440) % 1440;
			return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
		};
		const now = new Date();
		const mins = now.getHours() * 60 + now.getMinutes();
		const window = `${fmt(mins - 60)}-${fmt(mins + 60)}`;
		stackEnv(`  darkhub:
    host: dark.threads.dk
    quiet_hours: "${window}"`);
		delete process.env.SUSPENDERS_HUBS_FILE;
		const t0 = Date.now();
		expect(await resolveHub("darkhub")).toBeNull();
		// the early return must prove the check precedes the probe chain —
		// dns-sd alone would burn its 3s browse timeout
		expect(Date.now() - t0).toBeLessThan(1000);
	});
});

// leave the env as we found it — other suites read the real stack
import { afterAll } from "bun:test";
afterAll(() => {
	delete process.env.KLH_STACK;
	rmSync(home, { recursive: true, force: true });
});
