// test/export-go-gate.test.ts — W552.8: the export preflight reads the
// owner GO (bus broadcast or the 0600 go-owner seal) instead of staying
// operator-gated. Pure decision-core coverage; the CLI face is exercised
// live against the real bus.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	goEventFromScan,
	isOwnerGoNote,
	modeIs0600,
	parseGoSeal,
	sealFromEvent,
} from "../scripts/lib/export-go-gate.ts";

const GO_NOTE =
	"OWNER GO (2026-10-19, verbatim 'GO'): W552 governed IKEA demo export is authorized - the operator gate on the verified recording/replay export is open.";
const goEvent = (id: number, note: string, kind = "BROADCAST") => ({
	id,
	ts: 1792423802011,
	kind,
	scope: "suspenders",
	payload: { project: "/repo/.git", note },
});

describe("export-go-gate decision core", () => {
	test("finds the owner-GO broadcast in a coord events scan (newest wins)", () => {
		const scan = {
			events: [
				goEvent(46580, GO_NOTE),
				{ id: 46574, kind: "work.added", payload: {} },
				goEvent(46573, GO_NOTE),
			],
		};
		const go = goEventFromScan(scan);
		expect(go?.id).toBe(46580);
		expect(go?.note).toContain("OWNER GO");
	});

	test("ignores broadcasts without the W552 owner-GO marker", () => {
		const scan = { events: [goEvent(1, "W552 preflight ok, nothing new")] };
		expect(goEventFromScan(scan)).toBeNull();
	});

	test("non-array or absent event lists leave the gate closed", () => {
		expect(goEventFromScan(null)).toBeNull();
		expect(goEventFromScan({})).toBeNull();
		expect(goEventFromScan({ events: "corrupt" })).toBeNull();
	});

	test("marker requires both the GO verdict and the item id", () => {
		expect(isOwnerGoNote("OWNER GO: export authorized")).toBe(false);
		expect(isOwnerGoNote("W552 export GO")).toBe(false);
		expect(isOwnerGoNote(GO_NOTE)).toBe(true);
	});

	test("parses a valid seal and rejects corrupt or non-GO content", () => {
		const seal = parseGoSeal(
			JSON.stringify({ event: 46573, ts: 1, note: GO_NOTE }),
		);
		expect(seal?.event).toBe(46573);
		expect(parseGoSeal("not json")).toBeNull();
		expect(parseGoSeal(JSON.stringify({ event: 1, note: "nope" }))).toBeNull();
		expect(parseGoSeal(JSON.stringify({ note: 42 }))).toBeNull();
	});

	test("mode check pins 0600 exactly", () => {
		expect(modeIs0600(0o600)).toBe(true);
		expect(modeIs0600(0o644)).toBe(false);
		expect(modeIs0600(0o400)).toBe(false);
		expect(modeIs0600(0o700)).toBe(false);
	});

	test("seal from event carries id, ts and note verbatim", () => {
		const seal = sealFromEvent({ id: 46573, ts: 1792423802011, note: GO_NOTE });
		expect(seal).toEqual({ event: 46573, ts: 1792423802011, note: GO_NOTE });
	});
});

describe("export preflight CLI face", () => {
	test("fail-closed: a dead bus scan leaves the export gated (exit 1)", async () => {
		const run = Bun.spawnSync({
			cmd: [
				"bun",
				new URL("../scripts/w552-8-export-preflight.ts", import.meta.url)
					.pathname,
			],
			env: {
				...process.env,
				SUSPENDERS_COORD_CLI: "/usr/bin/false",
				FLEET_DEMO_KIT: join(tmpdir(), `w552-8-gate-test-${process.pid}`),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = new Response(run.stdout).text();
		const [stdout] = await Promise.all([out]);
		expect(run.exitCode).toBe(1);
		expect(stdout).toContain("OPERATOR-GATED");
		expect(stdout).toContain("bus scan failed");
	});
});
