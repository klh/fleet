import { expect, spyOn, test } from "bun:test";
import {
	type DispatchSummaryOpts,
	dispatchSummary,
	resolveDaemonizedPids,
} from "../scripts/lib/dispatch-summary.ts";
import { chosenExecutor } from "../scripts/lib/dispatch-executor-note.ts";
import type { LaneRef } from "../hooks/lib/lanes/lane-liveness.ts";

const wrapperPid = 3654;
const childPid = 3719;
const worktree = "/fleet/.worktrees/W562";
const lane = () => ({
	sid: "autow562",
	item: "W562",
	pid: wrapperPid,
	worktree,
});
const shell = (cmd: string[]): string =>
	cmd[0] === "ps"
		? `${wrapperPid} claude-runtime.ts\n${childPid} claude`
		: `p${wrapperPid}\nn${worktree}\np${childPid}\nn${worktree}\n`;
const anchored = (l: LaneRef): boolean => l.pid === wrapperPid;

test("cwd scan retains the SID-bearing managed wrapper over its native child", async () => {
	const live = [lane()];
	const dispatched = ["W562→autow562(pid 3654)"];
	await resolveDaemonizedPids(shell, dispatched, live, anchored, 0);
	expect(live[0]?.pid).toBe(wrapperPid);
	expect(dispatched).toHaveLength(1);
});

test("cwd scan cannot adopt an unanchored native child after wrapper loss", async () => {
	const live = [lane()];
	const dispatched = ["W562→autow562(pid 3654)"];
	await resolveDaemonizedPids(shell, dispatched, live, () => false, 0);
	expect(live[0]?.pid).toBe(wrapperPid);
	expect(dispatched).toHaveLength(1);
});

// W1353: the run tail discloses what each lane actually launched with.
const summaryOpts = (
	over: Partial<DispatchSummaryOpts>,
): DispatchSummaryOpts => ({
	liveCount: 2,
	targetEff: 3,
	heldSlots: 0,
	dispatched: ["W1→autow1(pid 5)", "W2→autow2(pid 6)"],
	seedFallbacks: [],
	readyCount: 0,
	resumeCount: 0,
	refusals: [],
	starved: new Map(),
	report: "REPORT-TABLE",
	...over,
});
const printed = (opts: DispatchSummaryOpts): string[] => {
	const spy = spyOn(console, "log").mockImplementation(() => {});
	try {
		dispatchSummary(opts);
		return spy.mock.calls.map((c) => String(c[0]));
	} finally {
		spy.mockRestore();
	}
};
const quotedRow = (item: string) =>
	chosenExecutor({
		item,
		pick: {
			bin: "claude",
			model: null,
			preference: { source: "default", directive: "default", line: 0 },
		},
		hub: null,
		route: null,
		routing: {
			prefer: null,
			must: "glm-5.3-flash",
			preferSource: null,
			mustSource: "/tree/.prefer",
		},
		repo: "/repo",
	});

test("executor table follows the fleet report and carries the quoted-prefer WARN once", () => {
	const rows = [quotedRow("W1"), quotedRow("W2")];
	const out = printed(summaryOpts({ chosen: rows }));
	const report = out.indexOf("REPORT-TABLE");
	expect(report).toBeGreaterThan(0);
	const block = out[report + 1] ?? "";
	expect(block).toContain(
		"dispatch executors (what each lane actually launched with):",
	);
	expect(block).toMatch(/W1\s+claude\s+glm-5\.3-flash\s+-\s+default ladder/);
	expect(block).toMatch(/W2\s+claude\s+glm-5\.3-flash/);
	expect(block.split("WARN — quoted .prefer").length - 1).toBe(1);
});

test("no chosen rows: the tail prints no executor table", () => {
	const none = printed(summaryOpts({})).join("\n");
	const empty = printed(summaryOpts({ chosen: [] })).join("\n");
	expect(none).not.toContain("dispatch executors");
	expect(empty).not.toContain("dispatch executors");
});
