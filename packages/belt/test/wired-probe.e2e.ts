import { expect, test } from "@playwright/test";
import { cimUsedGb, meminfoUsedGb, wiredGb } from "../bin/spawner.ts";

// W766: the wired-RAM guard's pressure probe, per OS. Parsers are pure and
// pinned here; the darwin leg runs the real vm_stat on this host.
test("linux meminfo: MemTotal − MemAvailable → GB @unit", () => {
	const out = [
		"MemTotal:       32000000 kB",
		"MemFree:        12345678 kB",
		"MemAvailable:    2000000 kB",
		"Buffers:          345678 kB",
		"Cached:          4567890 kB",
	].join("\n");
	expect(meminfoUsedGb(out)).toBeCloseTo(30000000 / 2 ** 20, 6);
});

test("linux meminfo: MemFree fallback when MemAvailable is absent @unit", () => {
	const out = [
		"MemTotal:       32000000 kB",
		"MemFree:        5000000 kB",
	].join("\n");
	expect(meminfoUsedGb(out)).toBeCloseTo(27000000 / 2 ** 20, 6);
});

test("linux meminfo: unparseable output fails closed (Infinity) @unit", () => {
	expect(meminfoUsedGb("not a meminfo")).toBe(Number.POSITIVE_INFINITY);
});

test("windows cim: max(working set, commit) kB → GB, CRLF tolerated @unit", () => {
	expect(cimUsedGb("2097152\r\n")).toBeCloseTo(2, 6);
	expect(cimUsedGb("220200960\n")).toBeCloseTo(210, 6);
});

test("windows cim: unparseable output fails closed (Infinity) @unit", () => {
	expect(cimUsedGb("Get-CimInstance : The server is not available.")).toBe(
		Number.POSITIVE_INFINITY,
	);
});

test("darwin leg: the real probe returns finite wired GB on this host @unit", () => {
	if (process.platform !== "darwin") return; // per-OS dispatch
	const wired = wiredGb();
	expect(Number.isFinite(wired) && wired >= 0).toBe(true);
});
