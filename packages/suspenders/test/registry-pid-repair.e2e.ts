import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeLaneRegistry,
	repairLaneRegistryPid,
} from "../hooks/lib/lanes/lane-registry.ts";
import {
	repairManagedWrapperPid,
	wrapperWitness,
	type RepairProbe,
} from "../scripts/lib/registry-pid-repair.ts";
import type { Lane } from "../hooks/lib/lanes/lane.ts";

const roots: string[] = [];
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "registry-pid-repair-"));
	roots.push(root);
	const sid = "autow1072-p123456789abcdef0";
	const lane = {
		sid,
		item: "W1072",
		pid: 201,
		branch: "suspenders/W1072",
		worktree: join(root, ".worktrees", "W1072"),
		launchedAt: 1,
	} as Lane;
	mergeLaneRegistry(root, [lane]);
	return { root, lane };
};

const probeFor = (lane: Lane): RepairProbe => ({
	rows: () => [
		{ pid: 201, ppid: 200, args: "/opt/bin/claude --resume a" },
		{
			pid: 200,
			ppid: 1,
			args: `bun /opt/suspenders/bin/claude-runtime.ts -p Lane ${lane.sid}`,
		},
	],
	birth: (pid) => ({ birth: `boot:${pid}` }),
});

test.afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test.describe("fenced managed wrapper PID repair", () => {
	test("preview leaves registry intact; apply adopts only exact SID parent", () => {
		const { root, lane } = fixture();
		const probe = probeFor(lane);
		expect(repairManagedWrapperPid(root, lane.sid, false, probe)).toEqual({
			state: "would-repair",
			pid: 200,
		});
		const file = join(root, ".fleet", "lanes.json");
		expect(JSON.parse(readFileSync(file, "utf8"))[0].pid).toBe(201);
		expect(repairManagedWrapperPid(root, lane.sid, true, probe)).toEqual({
			state: "repaired",
			pid: 200,
		});
		expect(JSON.parse(readFileSync(file, "utf8"))[0].pid).toBe(200);
	});

	test("rejects wrong SID, broken ancestry, or an incidental prompt mention", () => {
		const { lane } = fixture();
		const good = probeFor(lane);
		const rows = good.rows() ?? [];
		expect(
			wrapperWitness(lane, {
				...good,
				rows: () => [
					rows[0],
					{ ...rows[1], args: "bun /tmp/claude-runtime.ts -p other" },
				],
			}),
		).toBeNull();
		expect(
			wrapperWitness(lane, {
				...good,
				rows: () => [{ ...rows[0], ppid: 99 }, rows[1]],
			}),
		).toBeNull();
		expect(
			wrapperWitness(lane, {
				...good,
				rows: () => [
					rows[0],
					{
						...rows[1],
						args: `bun /tmp/unrelated.ts -p says /tmp/claude-runtime.ts ${lane.sid}`,
					},
				],
			}),
		).toBeNull();
	});

	test("refuses PID reuse between snapshot and locked recheck", () => {
		const { root, lane } = fixture();
		let checks = 0;
		const good = probeFor(lane);
		const changing: RepairProbe = {
			...good,
			birth: (pid) => ({
				birth: `boot:${pid}:${++checks > 2 ? "reused" : "original"}`,
			}),
		};
		expect(repairManagedWrapperPid(root, lane.sid, true, changing).state).toBe(
			"refused",
		);
		expect(
			JSON.parse(readFileSync(join(root, ".fleet", "lanes.json"), "utf8"))[0]
				.pid,
		).toBe(201);
	});

	test("locked compare-and-swap refuses a changed registry row", () => {
		const { root, lane } = fixture();
		mergeLaneRegistry(root, [{ ...lane, attempt: 2 }]);
		expect(repairLaneRegistryPid(root, lane, 200, () => true)).toBe(false);
	});
});
