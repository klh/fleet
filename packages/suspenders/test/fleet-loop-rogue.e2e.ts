// fleet-loop-rogue.test.ts — W266.3: the rogue-process sweep in the
// fleet-loop tick. Covers the pure parsers (ps / launchctl list), the
// supervision closure, episode transitions with injected IO, manifest
// degradation, and one live tick wiring proof: `fleet-loop once` in a
// scratch repo with staged launchctl/ps fixtures on PATH logs ROGUE for a
// marker-matching unsupervised process and writes the episode state.
import { expect, test } from "./pw";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.setTimeout(30_000);

import {
	createRogueSweep,
	markerOf,
	parseLaunchctlList,
	parsePs,
	supervisedPids,
} from "../hooks/lib/fleet-loop/rogue-sweep.ts";

const isDarwin = process.platform === "darwin";
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-rogue-"));
	mkdirSync(join(dir, ".fleet"));
	return dir;
};
const TAB = "	";

const stubDeps = (repo: string, lines: string[]) => ({
	REPO: repo,
	log: (m: string) => lines.push(m),
	sh: () => "",
	run: () => 0,
	runCap: () => ({ code: 0, out: "" }),
	lanes: () => [],
	bumpFail: () => 1,
	clearFail: () => {},
	ahead: () => 0,
});

// marker = last ≤3 literal segments of bunEntry: placeholder tokens and ..
// are install-machine substitution; the tail matches installed AND
// checkout runs of the same entry.
test.describe("markerOf", () => {
	test("buckle server: repo-relative tail across ..", () => {
		expect(markerOf("__REPO__/../buckle/src/server.ts")).toBe(
			"buckle/src/server.ts",
		);
	});
	test("prefix bin entries keep two segments", () => {
		expect(markerOf("__PREFIX__/bin/fleet-loop.ts")).toBe("bin/fleet-loop.ts");
	});
	test("runtime-home entries keep the home tail", () => {
		expect(markerOf("__HOME__/.claude/local-llm/swarm.ts")).toBe(
			"local-llm/swarm.ts",
		);
	});
	test("klh-local: bin parent survives in the tail", () => {
		expect(markerOf("__HOME__/.local/klh-local/bin/klh-local.ts")).toBe(
			"klh-local/bin/klh-local.ts",
		);
	});
});

test.describe("parsePs", () => {
	test("headerless rows with ragged whitespace", () => {
		expect(
			parsePs(
				"   1234       1 /opt/homebrew/bin/bun x.ts\n" +
					"      555      1 /bin/zsh\n",
			),
		).toEqual([
			{ pid: 1234, ppid: 1, cmd: "/opt/homebrew/bin/bun x.ts" },
			{ pid: 555, ppid: 1, cmd: "/bin/zsh" },
		]);
	});
});

test.describe("parseLaunchctlList", () => {
	test("header and not-running rows skipped, labels held", () => {
		const pids = parseLaunchctlList(
			"PID\tStatus\tLabel\n" +
				"87401\t0\tcom.suspenders.board\n" +
				"-\t0\tcom.suspenders.soak\n",
		);
		expect(pids.get("com.suspenders.board")).toBe(87401);
		expect(pids.has("com.suspenders.soak")).toBe(false);
	});
});

test.describe("supervisedPids", () => {
	test("label pids + transitive descendants, strangers stay out", () => {
		const rows = parsePs(
			"100      1 bun board\n" +
				"200    100 bun serve-child\n" +
				"300    200 bun model-server\n" +
				"400      1 bun hand-started\n",
		);
		const sup = supervisedPids(rows, [100]);
		expect(sup.has(100)).toBe(true);
		expect(sup.has(200)).toBe(true);
		expect(sup.has(300)).toBe(true);
		expect(sup.has(400)).toBe(false);
	});
});

test.describe("createRogueSweep episodes", () => {
	const realManifest = join(import.meta.dir, "..", "deploy", "services.yaml");
	const PS_ROGUE =
		" 87401 1 bun fleet-board.ts\n   777 555 bun dashboard.ts\n   555 1 /bin/zsh\n";
	const PS_CLEAN = " 87401 1 bun fleet-board.ts\n";
	const LC = [
		["PID", "Status", "Label"].join(TAB),
		["87401", "0", "com.suspenders.board"].join(TAB),
	].join("\n");

	test.skipIf(!isDarwin)("episode: ROGUE, dedupe, CLEAR", () => {
		const repo = scratch();
		const lines: string[] = [];
		const deps = {
			...stubDeps(repo, lines),
			manifestPath: realManifest,
		};
		const { rogueSweep } = createRogueSweep({
			...deps,
			launchctlList: () => LC,
			psOut: () => PS_ROGUE,
		});
		rogueSweep();
		rogueSweep(); // identical table -> episode dedupe
		expect(lines.filter((l) => l.startsWith("ROGUE "))).toHaveLength(1);
		expect(lines.some((l) => l.includes("pid=777"))).toBe(true);
		const { rogueSweep: sweep2 } = createRogueSweep({
			...deps,
			launchctlList: () => LC,
			psOut: () => PS_CLEAN,
		});
		sweep2(); // table cleared -> one CLEAR episode, state updated
		expect(lines.some((l) => l.includes("ROGUE-CLEAR"))).toBe(true);
		const state = JSON.parse(
			readFileSync(join(repo, ".fleet", "rogue.json"), "utf8"),
		) as Record<string, string>;
		expect(Object.keys(state)).toEqual([]);
		rmSync(repo, { recursive: true, force: true });
	});

	test("unreadable manifest degrades to an idle sweep, warned once", () => {
		const repo = scratch();
		const lines: string[] = [];
		const { rogueSweep } = createRogueSweep({
			...stubDeps(repo, lines),
			manifestPath: join(repo, "no-such.yaml"),
		});
		expect(lines.filter((l) => l.includes("ROGUE-SWEEP-IDLE"))).toHaveLength(1);
		rogueSweep();
		rogueSweep();
		expect(lines).toHaveLength(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test.skipIf(!isDarwin)("live tick with staged PATH", () => {
		const repo = scratch();
		const bin = join(repo, "fixture-bin");
		mkdirSync(bin, { recursive: true });
		const lcScript = join(bin, "launchctl");
		writeFileSync(
			lcScript,
			`#!/usr/bin/env bun
console.log("PID\tStatus\tLabel");
console.log("87401\t0\tcom.suspenders.board");
`,
		);
		chmodSync(lcScript, 0o755);
		const psScript = join(bin, "ps");
		writeFileSync(
			psScript,
			`#!/usr/bin/env bun
console.log("  87401     1 bun fleet-board.ts");
console.log("    777     1 bun /tmp/x/dashboard.ts");
`,
		);
		chmodSync(psScript, 0o755);
		const home = join(repo, ".test-home");
		mkdirSync(home, { recursive: true });
		Bun.spawnSync(["git", "init", "-q", repo]);
		const fleetLoop = join(
			import.meta.dir,
			"..",
			"hooks",
			"bin",
			"fleet-loop.ts",
		);
		const p = Bun.spawnSync(
			[process.execPath, fleetLoop, "once", "--repo", repo],
			{
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: home,
					GOVERNOR_STORE_URL: "",
					PATH: `${bin}:${process.env.PATH}`,
				},
			},
		);
		if (p.exitCode !== 0)
			console.error(
				"fleet-loop stderr:",
				new TextDecoder().decode(p.stderr ?? new Uint8Array()),
			);
		expect(p.exitCode).toBe(0);
		const logText = readFileSync(join(repo, ".fleet", "loop.log"), "utf8");
		expect(logText).toMatch(/ROGUE pid=777/);
		expect(logText).not.toContain("ROGUE sweep failed");
		const state = JSON.parse(
			readFileSync(join(repo, ".fleet", "rogue.json"), "utf8"),
		) as Record<string, string>;
		expect(Object.keys(state)).toContain("777");
		rmSync(repo, { recursive: true, force: true });
	});
});
