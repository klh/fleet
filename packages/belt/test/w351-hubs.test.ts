// W351 — remote buckle hubs as supervised probe-only rows: registry parsing,
// supervisor target shape, fleetTargets port dedupe, llms.txt row rendering.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubLlmsRows, hubTargets, readHubs } from "../bin/hubs.ts";
import { fleetTargets, isAlert } from "../bin/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "w351-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REGISTRY = {
	NAS: { candidates: ["http://nas.example.lan:4101"] },
	DESKTOP: { candidates: ["https://desktop.example.lan"] },
};

function regFile(body: unknown): string {
	const p = join(dir, `reg-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(p, JSON.stringify(body));
	return p;
}

describe("readHubs", () => {
	test("missing file → no rows (belt runs hub-less)", () => {
		expect(readHubs(join(dir, "nope.json"))).toEqual([]);
	});

	test("parses http + https candidates to host/port/tls", () => {
		expect(readHubs(regFile(REGISTRY))).toEqual([
			{
				label: "NAS",
				base: "http://nas.example.lan:4101",
				host: "nas.example.lan",
				port: 4101,
				tls: false,
			},
			{
				label: "DESKTOP",
				base: "https://desktop.example.lan",
				host: "desktop.example.lan",
				port: 443,
				tls: true,
			},
		]);
	});

	test("skips junk entries (no candidates / bad URL / bad scheme)", () => {
		const rows = readHubs(
			regFile({
				EMPTY: {},
				NOURL: { candidates: ["not a url"] },
				FTP: { candidates: ["ftp://x"] },
				GOOD: { candidates: ["http://g.example.lan:2"] },
			}),
		);
		expect(rows.map((r) => r.label)).toEqual(["GOOD"]);
	});
});

describe("hubTargets", () => {
	test("probe-only rows with parsed host/port + scheme for TLS", () => {
		process.env.SUSPENDERS_HUBS_FILE = regFile(REGISTRY);
		try {
			expect(hubTargets()).toEqual([
				{
					name: "NAS",
					port: 4101,
					kind: "hub",
					owned: false,
					host: "nas.example.lan",
					healthPath: "/api/health",
				},
				{
					name: "DESKTOP",
					port: 443,
					kind: "hub",
					owned: false,
					host: "desktop.example.lan",
					scheme: "https",
					healthPath: "/api/health",
				},
			]);
		} finally {
			delete process.env.SUSPENDERS_HUBS_FILE;
		}
	});

	test("an unowned hub never alerts — visibility, not alarms", () => {
		expect(isAlert("hub", false, "down")).toBe(false);
		expect(isAlert("hub", false, "up")).toBe(false);
	});
});

describe("fleetTargets", () => {
	test("fleet rows keep unique ports with hubs folded in", () => {
		const ts = fleetTargets();
		const ports = ts.map((t) => t.port);
		expect(new Set(ports).size).toBe(ports.length);
		for (const hub of ts.filter((t) => t.kind === "hub")) {
			expect(hub.owned).toBe(false);
			expect(hub.host).toBeTruthy();
		}
	});
});

test("llms rows render label + base + state", () => {
	expect(hubLlmsRows(readHubs(regFile(REGISTRY)), () => "up")).toEqual([
		"- NAS http://nas.example.lan:4101 — up",
		"- DESKTOP https://desktop.example.lan — up",
	]);
});
