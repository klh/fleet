// test/runtime-sync.test.ts — W821 post-merge runtime sync: the pure
// decision core (label rules + drift decision), the fleet-loop sweep (spawn
// injected — no real children), and the runner resolution guard.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	labelsForChanges,
	decideRuntimeSync,
} from "../scripts/lib/runtime-sync.ts";
import { createRuntimeSync } from "../hooks/lib/fleet-loop/runtime-sync.ts";
import { suspendersRoot } from "../hooks/lib/fleet-loop/maintenance.ts";
import { writeStamp } from "../scripts/lib/auto-install.ts";

describe("labelsForChanges (W821)", () => {
	test("belt changes serve two surfaces", () => {
		expect(labelsForChanges(["packages/belt/bin/router-shim.ts"])).toEqual([
			"com.suspenders.belt-swarm",
			"com.belt.dashboard",
		]);
	});
	test("buckle and suspenders map to their own labels", () => {
		expect(labelsForChanges(["packages/buckle/src/server.ts"])).toEqual([
			"com.suspenders.buckle-spoke",
		]);
		expect(
			labelsForChanges(["packages/suspenders/hooks/bin/fleet-board.ts"]),
		).toEqual(["com.suspenders.board"]);
	});
	test("root/docs changes label nothing; prefix boundary holds", () => {
		expect(labelsForChanges(["README.md", "docs/x.md"])).toEqual([]);
		expect(labelsForChanges(["packages/belt/docs/x.md"])).toHaveLength(2);
		expect(labelsForChanges(["packages/beltx/src/x.ts"])).toEqual([]);
	});
});

describe("decideRuntimeSync (W821)", () => {
	test("git failure never syncs; equal head+stamp is up-to-date", () => {
		expect(
			decideRuntimeSync({ head: null, stamp: "a", paths: ["x"] }).action,
		).toBe("skip");
		expect(
			decideRuntimeSync({ head: "a", stamp: "a", paths: null }).action,
		).toBe("skip");
	});
	test("first run (no stamp) syncs without kicks; unreadable diff syncs bare", () => {
		const first = decideRuntimeSync({ head: "a", stamp: null, paths: null });
		expect(first).toEqual({ action: "sync", labels: [] });
		const bare = decideRuntimeSync({ head: "b", stamp: "a", paths: null });
		expect(bare).toEqual({ action: "sync", labels: [] });
	});
	test("drift paths derive the kick labels", () => {
		expect(
			decideRuntimeSync({
				head: "b",
				stamp: "a",
				paths: ["packages/buckle/src/server.ts", "README.md"],
			}),
		).toEqual({ action: "sync", labels: ["com.suspenders.buckle-spoke"] });
	});
});

const tmp = mkdtempSync(join(tmpdir(), "rtsync-"));
const stampsPath = join(tmp, "stamp.json");
const lines: string[] = [];

const mkDeps = (head: string) => ({
	REPO: tmp,
	MAIN: "main",
	log: (msg: string): void => {
		lines.push(msg);
	},
	sh: (cmd: string[]) => (cmd[0] === "git" ? head : ""),
	run: () => 0,
	runCap: () => ({ code: 0, out: "" }),
	lanes: () => [],
	bumpFail: () => 1,
	clearFail: () => {},
	ahead: () => 0,
});

describe("runtime-sync sweep (W821)", () => {
	test("runner resolves at the package root", () => {
		expect(
			existsSync(join(suspendersRoot(), "scripts/post-merge-sync.ts")),
		).toBe(true);
	});
	test("drift spawns the runner child; up-to-date never spawns", () => {
		writeStamp(stampsPath, "aaa");
		const seen: string[][] = [];
		const { runtimeSync } = createRuntimeSync(mkDeps("bbb"), {
			statePath: stampsPath,
			spawn: (cmd) => {
				seen.push(cmd);
				return { code: 0, out: "" };
			},
		});
		const r = runtimeSync();
		expect(r.ran).toBe(true);
		expect(seen[0].slice(-2)).toEqual([
			"--repo",
			join(tmp, "packages/suspenders"),
		]);
		expect(seen[0][1].endsWith("post-merge-sync.ts")).toBe(true);
	});
	test("up-to-date: equal head+stamp is a silent no-op", () => {
		writeStamp(stampsPath, "ccc");
		const { runtimeSync } = createRuntimeSync(mkDeps("ccc"), {
			statePath: stampsPath,
			spawn: () => {
				throw new Error("must not spawn");
			},
		});
		const r = runtimeSync();
		expect(r.ran).toBe(false);
	});
	test("git failure waits (no spawn)", () => {
		rmSync(stampsPath, { force: true });
		const { runtimeSync } = createRuntimeSync(mkDeps(""), {
			statePath: stampsPath,
			spawn: () => {
				throw new Error("must not spawn");
			},
		});
		const r = runtimeSync();
		expect(r.ran).toBe(false);
		expect(r.reason).toBe("git-failed");
	});
});
