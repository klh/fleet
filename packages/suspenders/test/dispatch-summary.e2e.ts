import { expect, test } from "@playwright/test";
import { resolveDaemonizedPids } from "../scripts/lib/dispatch-summary.ts";
import type { LaneRef } from "../hooks/lib/lanes/lane-liveness.ts";
test.describe({ tag: "@unit" }, () => {

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

});
