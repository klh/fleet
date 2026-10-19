import { describe, expect, test } from "bun:test";
import {
	p95,
	parseDf,
	parseTop,
	splitTask,
} from "../scripts/lib/capacity-math.ts";

describe("W842 capacity math", () => {
	test("p95 nearest-rank over sorted walls", () => {
		expect(p95([])).toBe(null);
		expect(p95([100])).toBe(100);
		expect(p95([10, 20, 30, 40])).toBe(40);
		expect(p95([300, 300, ...Array(18).fill(50)])).toBe(300);
	});

	test("splitTask strips one leading bun token", () => {
		expect(splitTask("bun test x")).toEqual(["test", "x"]);
		expect(splitTask("test x")).toEqual(["test", "x"]);
	});

	test("parseTop reads active CPU and used memory from top output", () => {
		const out = [
			"Processes: 678 total...",
			"PhysMem: 88G used (12G wired), 40G unused.",
			"CPU usage: 25.1% user, 10.2% sys, 64.7% idle",
		].join("\n");
		const r = parseTop(out);
		expect(r.cpuActive).toBe(35.3);
		expect(r.memUsedGb).toBe(88);
	});

	test("parseDf reads available KiB from the data row", () => {
		const out =
			"Filesystem 1024-blocks Used Available Capacity iused\n" +
			"/dev/disk3s1s1 4943847 3769261 2630000 60% 1234 2% /";
		expect(parseDf(out)).toBe(2630000);
	});
});
