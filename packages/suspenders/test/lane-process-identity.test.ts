import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
	laneProcessIdentity,
	type ProcessInspector,
} from "../hooks/lib/lane-liveness.ts";
import { safeToRetire } from "../hooks/lib/lane-registry.ts";
import { alive } from "../scripts/lib/lane.ts";

const lane = { sid: "autow562", item: "W562", pid: 562 };
const roster =
	(stdout: string, exitCode = 0): ProcessInspector =>
	() => ({ stdout, exitCode });
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("identity requires exact PID, harness and lane token", () => {
	expect(
		laneProcessIdentity(lane, roster("562 /bin/claude -p mission autow562")),
	).toBe(true);
	expect(
		laneProcessIdentity(lane, roster("562 claude -p mission autow562")),
	).toBe(true);
	expect(
		laneProcessIdentity(lane, roster("562 /bin/claude -p mission autow5620")),
	).toBe(false);
	expect(
		laneProcessIdentity(lane, roster("5620 /bin/claude -p mission autow562")),
	).toBe(false);
	expect(
		laneProcessIdentity(
			lane,
			roster("562 bun /home/.claude/coord.ts subscribe --as autow562"),
		),
	).toBe(false);
});

test("an existing unrelated process is not the recorded lane", () => {
	expect(() => process.kill(process.pid, 0)).not.toThrow();
	expect(alive({ ...lane, pid: process.pid })).toBe(false);
	expect(
		laneProcessIdentity(lane, roster("562 bun /review/live-wire.json")),
	).toBe(false);
});

test("failed, empty, malformed or thrown inspection remains unknown", () => {
	for (const inspect of [
		roster("562 /bin/claude autow562", 1),
		roster(""),
		roster("truncated"),
		() => {
			throw new Error("denied");
		},
	]) {
		const live = laneProcessIdentity(lane, inspect);
		expect(live).toBeNull();
		expect(
			safeToRetire({
				registryKnown: true,
				claimKnown: true,
				claimed: false,
				recentlyLaunched: false,
				live,
			}),
		).toBe(false);
	}
});

test("foreign host inspection cannot bless or retire a remote PID", () => {
	expect(
		laneProcessIdentity(
			{ ...lane, host: `${hostname()}-remote` },
			roster("562 claude autow562"),
		),
	).toBeNull();
	expect(laneProcessIdentity({ ...lane, pid: 0 }, roster("1 init"))).toBe(
		false,
	);
	expect(
		laneProcessIdentity({ ...lane, pid: -1 }, roster("1 init")),
	).toBeNull();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-w562-"));
	roots.push(root);
	expect(
		Bun.spawnSync(["git", "init", root], { stdout: "pipe", stderr: "pipe" })
			.exitCode,
	).toBe(0);
	mkdirSync(join(root, ".fleet"));
	writeFileSync(
		join(root, ".fleet", "lanes.json"),
		JSON.stringify([
			{
				...lane,
				pid: process.pid,
				branch: "lane/W562",
				worktree: join(root, ".worktrees/W562"),
			},
		]),
	);
	return root;
}

test("fleet-loop status and script status never report a reused PID alive", () => {
	const root = fixture();
	const loop = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../hooks/bin/fleet-loop.ts"),
			"lanes",
			"--repo",
			root,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(loop.exitCode).toBe(0);
	expect(loop.stdout.toString()).toContain("dead ");
	expect(loop.stdout.toString()).not.toContain("ALIVE");
	const script = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../scripts/lanes.ts"),
			"--repo",
			root,
		],
		{ stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: root } },
	);
	expect(script.exitCode).toBe(0);
	expect(script.stdout.toString()).toContain("1 dead, 0 unknown");
});

test("fleet-loop refuses duplicate dispatch when process inspection fails", () => {
	const root = fixture();
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../hooks/bin/fleet-loop.ts"),
			"dispatch",
			"--repo",
			root,
			"--item",
			"W562",
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		},
	);
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain(
		"process identity unknown; refusing duplicate dispatch",
	);
});
