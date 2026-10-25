import { afterEach, expect, test } from "@playwright/test";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
	laneProcessIdentity,
	isHarnessProcess,
	type ProcessInspector,
} from "../hooks/lib/lanes/lane-liveness.ts";
import { safeToRetire } from "../hooks/lib/lanes/lane-registry.ts";
import { alive } from "../hooks/lib/lanes/lane.ts";
test.describe({ tag: "@unit" }, () => {

const lane = { sid: "autow562", item: "W562", pid: 562 };
const roster =
	(stdout: string, exitCode = 0): ProcessInspector =>
	() => ({ stdout, exitCode });
const roots: string[] = [];

test("legacy brief and settings filenames retain ambiguous Claude and Copilot lanes", () => {
	for (const executable of ["/missing/claude/versions/2.1.283", "copilot"]) {
		for (const reference of [
			"/project/.fleet/brief-autow562.md",
			"--settings /project/.fleet/lane-settings-autow562.json",
		])
			expect(
				laneProcessIdentity(
					lane,
					roster(`562 ${executable} -p Read ${reference}`),
				),
			).toBeNull();
	}
	expect(
		laneProcessIdentity(
			lane,
			roster("562 bun /review.ts -p /project/.fleet/brief-autow562.md"),
		),
	).toBe(false);
	expect(
		laneProcessIdentity(
			lane,
			roster("562 claude -p /project/.fleet/brief-autow5620.md"),
		),
	).toBe(false);
	expect(
		laneProcessIdentity(
			lane,
			roster("562 claude -p /project/.fleet/lane-settings-autow5620.json"),
		),
	).toBe(false);
});

test("legacy references require the canonical project path when the worktree identifies it", () => {
	const scoped = { ...lane, worktree: "/project/.worktrees/W562" };
	expect(
		laneProcessIdentity(
			scoped,
			roster("562 claude -p Read /project/.fleet/brief-autow562.md"),
		),
	).toBeNull();
	expect(
		laneProcessIdentity(
			scoped,
			roster("562 claude -p Read /other/.fleet/brief-autow562.md"),
		),
	).toBe(false);
	expect(
		laneProcessIdentity(
			scoped,
			roster(
				"562 claude -p Read --settings /other/.fleet/lane-settings-autow562.json",
			),
		),
	).toBe(false);
	expect(
		laneProcessIdentity(
			scoped,
			roster(
				"562 claude -p Lane autow562. Read /project/.worktrees/W562/.klh-brief.md",
			),
		),
	).toBe(true);
});

test("native versioned executable and runtime entrypoint are command-position identities", () => {
	const native = "/home/agent/.local/share/claude/versions/2.1.283";
	const script = "/opt/node_modules/@anthropic-ai/claude-code/cli.js";
	const canonical = new Set([native, script]);
	for (const args of [
		`${native} -p autow562`,
		`562 ${native} -p autow562`,
		`/usr/bin/node ${script} -p autow562`,
		`/usr/bin/bun ${script} -p autow562`,
		"claude -p autow562",
		"/bin/codex exec autow562",
	])
		expect(isHarnessProcess(args, canonical)).toBe(true);
	for (const args of [
		"/usr/bin/bun /review.ts -p read /opt/claude autow562",
		"/usr/bin/node -e /opt/claude autow562",
		"bun /home/.claude/coord.ts subscribe --as autow562",
		`/usr/bin/node /review.ts -p ${script} autow562`,
	])
		expect(isHarnessProcess(args, canonical)).toBe(false);
	expect(
		isHarnessProcess(
			"/home/agent/.local/share/claude/versions/9.9.9 -p autow562",
			canonical,
		),
	).toBeNull();
});

test("managed Claude wrapper is the SID-bearing lane identity, not its native child", () => {
	const wrapper = "/fleet/hooks/bin/claude-runtime.ts";
	const rows = roster(
		`3654 bun ${wrapper} -p Lane autow562 --settings /fleet/.fleet/lane-settings-autow562.json\n3719 /home/agent/.local/bin/claude --resume seed -p --verbose`,
	);
	expect(laneProcessIdentity({ ...lane, pid: 3654 }, rows)).toBe(true);
	expect(laneProcessIdentity({ ...lane, pid: 3719 }, rows)).toBe(false);
});

test("restarted managed identity binds the exact settings argument to its worktree and SID", () => {
	const scoped = { ...lane, worktree: "/project/.worktrees/W562" };
	const settings = `${scoped.worktree}/.fleet/restart-settings-${lane.sid}.json`;
	const wrapper = "/generation/hooks/bin/claude-runtime.ts";
	for (const argument of [settings, `"${settings}"`, `'${settings}'`])
		expect(
			laneProcessIdentity(
				scoped,
				roster(
					`562 bun ${wrapper} -p Await resume --settings ${argument} --resume uuid`,
				),
			),
		).toBe(true);
	for (const args of [
		`bun ${wrapper} -p Await resume --settings ${settings.replace("W562", "W563")}`,
		`bun ${wrapper} -p Await resume --settings ${settings.replace("autow562", "autow562-other")}`,
		`bun ${wrapper} -p Await resume --settings ${settings}.backup`,
		`bun ${wrapper} -p Read ${settings}`,
		`bun ${wrapper} -p "Read --settings ${settings}"`,
		`bun ${wrapper} --settings ${settings} --settings ${settings}`,
		`bun /review.ts -p Read ${wrapper} --settings ${settings}`,
		`claude -p Await resume --settings ${settings}`,
	])
		expect(laneProcessIdentity(scoped, roster(`562 ${args}`))).toBe(false);
	expect(
		laneProcessIdentity(
			lane,
			roster(`562 bun ${wrapper} --settings ${settings}`),
		),
	).toBe(false);
});

test("a real managed Bun process retains restart identity without inference", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-real-restart-"));
	roots.push(root);
	const worktree = join(root, ".worktrees", lane.item);
	mkdirSync(join(worktree, ".fleet"), { recursive: true });
	const runtime = join(root, "claude-runtime.ts");
	const settings = join(
		worktree,
		".fleet",
		`restart-settings-${lane.sid}.json`,
	);
	writeFileSync(settings, "{}");
	writeFileSync(runtime, "console.log('ready'); await Bun.sleep(60000);");
	const child = Bun.spawn(
		[process.execPath, runtime, "-p", "Await resume", "--settings", settings],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("ready");
		reader.releaseLock();
		expect(laneProcessIdentity({ ...lane, pid: child.pid, worktree })).toBe(
			true,
		);
		expect(
			laneProcessIdentity({
				...lane,
				sid: `${lane.sid}-other`,
				pid: child.pid,
				worktree,
			}),
		).toBe(false);
	} finally {
		child.kill();
		await child.exited;
	}
	expect(laneProcessIdentity({ ...lane, pid: child.pid, worktree })).toBe(
		false,
	);
});

test("canonical symlink resolution recognizes native upgrades and actual Node entrypoints", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-executable-"));
	roots.push(root);
	const bin = join(root, "bin");
	const versions = join(root, "claude/versions");
	mkdirSync(bin);
	mkdirSync(versions, { recursive: true });
	const native = join(versions, "2.1.283");
	const entrypoint = join(root, "copilot-cli.js");
	writeFileSync(native, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(entrypoint, "#!/usr/bin/env node\n", { mode: 0o700 });
	symlinkSync(native, join(bin, "claude"));
	symlinkSync(entrypoint, join(bin, "copilot"));
	const path = process.env.PATH;
	process.env.PATH = bin;
	try {
		expect(laneProcessIdentity(lane, roster(`562 ${native} -p autow562`))).toBe(
			true,
		);
		expect(
			laneProcessIdentity(
				lane,
				roster(`562 ${native} -p Read /project/.fleet/brief-autow562.md`),
			),
		).toBeNull();
		expect(
			laneProcessIdentity(
				lane,
				roster(
					`562 /usr/bin/node ${entrypoint} -p Read /project/.fleet/brief-autow562.md`,
				),
			),
		).toBeNull();
		expect(isHarnessProcess(`/usr/bin/node ${entrypoint} -p autow562`)).toBe(
			true,
		);
		expect(
			isHarnessProcess(`/usr/bin/bun /review.ts -p ${entrypoint} autow562`),
		).toBe(false);
	} finally {
		process.env.PATH = path;
	}
	expect(
		isHarnessProcess(`${join(versions, "missing")} -p autow562`),
	).toBeNull();
});

test("bare launchd PATH still resolves the native install via declared locations (W626)", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-w626-launchd-"));
	roots.push(root);
	const versions = join(root, "claude/versions");
	mkdirSync(versions, { recursive: true });
	const native = join(versions, "2.1.283");
	writeFileSync(native, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	mkdirSync(join(root, ".local/bin"), { recursive: true });
	symlinkSync(native, join(root, ".local/bin/claude"));
	const env = { PATH: process.env.PATH, HOME: process.env.HOME };
	process.env.HOME = root;
	process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
	try {
		expect(laneProcessIdentity(lane, roster(`562 ${native} -p autow562`))).toBe(
			true,
		);
		expect(
			laneProcessIdentity(
				lane,
				roster(`562 ${native} -p Read /project/.fleet/brief-autow562.md`),
			),
		).toBeNull();
	} finally {
		process.env.HOME = env.HOME;
		process.env.PATH = env.PATH;
	}
});

test("retirement retains an unresolved native executable and ignores prompt-only harness paths", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-retirement-identity-"));
	roots.push(root);
	const ps = join(root, "ps");
	const observe = () => {
		const script = `import { retirementProcessLive } from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/lanes/lane-registry.ts"))}; console.log(JSON.stringify(retirementProcessLive(${JSON.stringify(root)})));`;
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, PATH: root },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		return JSON.parse(child.stdout.toString());
	};
	writeFileSync(
		ps,
		"#!/bin/sh\nprintf '%s\\n' '562 /missing/claude/versions/2.1.283 -p autow562'\n",
		{ mode: 0o700 },
	);
	expect(observe()).toBeNull();
	writeFileSync(
		ps,
		"#!/bin/sh\nprintf '%s\\n' '562 /usr/bin/bun /review.ts -p read /opt/claude autow562'\n",
		{ mode: 0o700 },
	);
	expect(observe()).toBe(false);
});
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

// W669.3: the parallel scripts/lanes.ts face is retired — `work lanes` /
// fleet-loop `lanes` is the one lane-liveness read; the reused-PID verdict
// (dead, never ALIVE) stays pinned here on the surviving face.
test("fleet-loop status never reports a reused PID alive", () => {
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

});
