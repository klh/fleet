// W2618 belt occupancy face: the dashboard's per-hub fetch degrades
// honestly — a tokenless hub, an unreachable hub and a shape-drift payload
// each answer null report + note (never a fabricated zero), a live stub
// hub answers its real report, and the dashboard API payload wraps rows
// with the updated stamp.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { serveStub } from "@klh/test-kit";
import { hubOccupancy, occupancyApiPayload } from "../bin/occupancy-face.ts";
import type { HubRow } from "../bin/hubs.ts";

const REPORT = {
	hub: "stubhub",
	enabled: true,
	generated_ms: 1,
	caps: null,
	derived_total: 6,
	totals: { current: 1, max: 6, basis: "derived" },
	models: [],
	users: [],
	gauges: { admitted_1m: 1, admitted_5m: 2, active: 1 },
	samples: [],
};

const hubOf = (base: string): HubRow => ({
	label: "stubhub",
	base,
	host: "127.0.0.1",
	port: 1,
	tls: false,
});

test.describe("hubOccupancy", () => {
	test("tokenless hub answers null + note", async () => {
		const row = await hubOccupancy(hubOf("http://127.0.0.1:1"), null);
		expect(row.report).toBeNull();
		expect(row.note).toContain("token_file");
	});

	test("unreachable hub answers null + note", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w2618-occ-"));
		const tok = join(dir, "tok");
		writeFileSync(tok, "k-s1-test", { mode: 0o600 });
		try {
			const row = await hubOccupancy(hubOf("http://127.0.0.1:1"), tok);
			expect(row.report).toBeNull();
			expect(row.note).toContain("unreachable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("shape-drift payload answers null + note", async () => {
		const stub = serveStub(() => Response.json({ nope: true }));
		const dir = mkdtempSync(join(tmpdir(), "w2618-occ-"));
		const tok = join(dir, "tok");
		writeFileSync(tok, "k-s1-test", { mode: 0o600 });
		try {
			const row = await hubOccupancy(hubOf(stub.url), tok);
			expect(row.report).toBeNull();
			expect(row.note).toContain("payload shape");
		} finally {
			stub.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// W2781: NESTED drift (a top-level-valid body with a garbage models row)
	// must also refuse — the hand-rolled pre-W2781 check accepted it and the
	// card renderer consumed a half-shaped row.
	test("nested shape drift answers null + note", async () => {
		const stub = serveStub(() =>
			Response.json({ ...REPORT, models: [{ model: "m", current: 1 }] }),
		);
		const dir = mkdtempSync(join(tmpdir(), "w2781-occ-"));
		const tok = join(dir, "tok");
		writeFileSync(tok, "k-s1-test", { mode: 0o600 });
		try {
			const row = await hubOccupancy(hubOf(stub.url), tok);
			expect(row.report).toBeNull();
			expect(row.note).toContain("payload shape");
		} finally {
			stub.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a live stub hub answers its report", async () => {
		const stub = serveStub(() => Response.json(REPORT));
		const dir = mkdtempSync(join(tmpdir(), "w2618-occ-"));
		const tok = join(dir, "tok");
		writeFileSync(tok, "k-s1-test", { mode: 0o600 });
		try {
			const row = await hubOccupancy(hubOf(stub.url), tok);
			expect(row.note).toBeNull();
			expect(row.report?.enabled).toBe(true);
			expect(row.report?.totals.max).toBe(6);
		} finally {
			stub.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("occupancyApiPayload wraps rows with the updated stamp", async () => {
	const payload = await occupancyApiPayload();
	expect(typeof payload.updated).toBe("string");
	expect(Array.isArray(payload.hubs)).toBe(true);
});
