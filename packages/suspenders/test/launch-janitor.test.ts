// test/launch-janitor.test.ts — W1247: the .fleet launch-debris janitor.
// Nonce grouping, the registered-current keep (uncertainty keeps), the
// age rule on a group's YOUNGEST file, the batch bound, pause and the
// dry-run default — all store-free (intents + inspect injected).
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyGroups,
	createLaunchJanitor,
	groupByNonce,
	LAUNCH_FILE,
	LAUNCH_JANITOR_PAUSE_MARKER,
	youngestMtime,
} from "../hooks/lib/launch-janitor.ts";
import type { LaunchIntent } from "../hooks/lib/launch-janitor.ts";
import type { LaunchJanitorDeps } from "../hooks/lib/launch-janitor.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const intent = (
	nonce: string,
	over: Partial<LaunchIntent> = {},
): LaunchIntent => ({
	project: "p",
	item: `W-${nonce.slice(0, 4)}`,
	sid: `s-${nonce.slice(0, 4)}`,
	nonce,
	revision: 1,
	executor: "/bin/true",
	host: "h",
	attempt: 1,
	state: "REGISTERED",
	pid: null,
	birth: null,
	...over,
});

const freshDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "lj-"));
	return dir;
};

const seed = (dir: string, name: string, ageMs: number): void => {
	const path = join(dir, name);
	writeFileSync(path, "x");
	utimesSync(path, new Date(NOW - ageMs), new Date(NOW - ageMs));
};

const janitor = (over: Partial<LaunchJanitorDeps> = {}) =>
	createLaunchJanitor({
		repo: "/unused",
		act: false,
		maxAgeDays: 7,
		dir: freshDir(),
		now: (): number => NOW,
		...over,
	});

describe("launch file shape (W1247)", () => {
	test("regex matches the three fenced shapes, not the pause marker", () => {
		expect(LAUNCH_FILE.test("launch-a1.json")).toBe(true);
		expect(LAUNCH_FILE.test("launch-a1.sh")).toBe(true);
		expect(LAUNCH_FILE.test("launch-a1.json.registered")).toBe(true);
		expect(LAUNCH_FILE.test("launch-janitor-paused")).toBe(false);
		expect(LAUNCH_FILE.test("launch-a1.txt")).toBe(false);
		expect(LAUNCH_FILE.exec("launch-a1.json.registered")?.[1]).toBe("a1");
	});

	test("groupByNonce collects a nonce's siblings together", () => {
		const groups = groupByNonce([
			"launch-a1.json",
			"launch-a1.sh",
			"launch-a1.json.registered",
			"launch-b2.json",
			"brief-x.md",
		]);
		expect(groups.get("a1")).toEqual([
			"launch-a1.json",
			"launch-a1.sh",
			"launch-a1.json.registered",
		]);
		expect(groups.get("b2")).toEqual(["launch-b2.json"]);
		expect(groups.has("brief-x.md")).toBe(false);
	});

	test("youngestMtime ignores vanished files and takes the max", () => {
		const dir = freshDir();
		seed(dir, "launch-c3.json", 10 * DAY);
		seed(dir, "launch-c3.json.registered", 10 * DAY);
		seed(dir, "launch-c3.sh", 60_000); // freshest sibling
		expect(
			youngestMtime(dir, [
				"launch-c3.json",
				"launch-c3.sh",
				"launch-c3.json.registered",
				"launch-gone.json",
			]),
		).toBeGreaterThan(NOW - DAY);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("launch janitor sweep (W1247)", () => {
	test("dry-run lists the stale orphan trio, keeps every byte on disk", () => {
		const dir = freshDir();
		for (const suffix of ["json", "sh", "json.registered"])
			seed(dir, `launch-orphan.${suffix}`, 30 * DAY);
		const r = janitor({ dir }).sweep();
		expect(r.dryRun).toBe(true);
		expect(r.groups).toBe(1);
		expect(r.pruned).toHaveLength(3);
		expect(r.errors).toEqual([]);
		expect(readdirSync(dir).sort()).toEqual([
			"launch-orphan.json",
			"launch-orphan.json.registered",
			"launch-orphan.sh",
		]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("act removes the whole nonce group", () => {
		const dir = freshDir();
		for (const suffix of ["json", "sh", "json.registered"])
			seed(dir, `launch-gone.${suffix}`, 30 * DAY);
		const r = janitor({ dir, act: true }).sweep();
		expect(r.pruned).toHaveLength(3);
		expect(existsSync(join(dir, "launch-gone.json"))).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("registered-current survives any age; dead rows do not", () => {
		const dir = freshDir();
		for (const suffix of ["json", "sh"])
			seed(dir, `launch-live.${suffix}`, 30 * DAY);
		for (const suffix of ["json", "sh"])
			seed(dir, `launch-dead.${suffix}`, 30 * DAY);
		const rows = [intent("live", { pid: 4242 }), intent("dead")];
		const inspect = (i: LaunchIntent): "alive" | "dead" | "unknown" =>
			i.pid === null ? "dead" : "alive";
		const r = janitor({
			dir,
			act: true,
			intents: (): LaunchIntent[] => rows,
			inspect,
		}).sweep();
		expect(r.keptCurrent).toBe(2);
		expect(r.pruned.map((p) => p.file).sort()).toEqual([
			"launch-dead.json",
			"launch-dead.sh",
		]);
		expect(existsSync(join(dir, "launch-live.json"))).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("uncertainty keeps: unknown inspect + replaced attempt, old, act", () => {
		const dir = freshDir();
		seed(dir, "launch-replaced.json", 30 * DAY);
		seed(dir, "launch-ghost.json", 30 * DAY);
		const r = janitor({
			dir,
			act: true,
			intents: (): LaunchIntent[] => [intent("replaced")],
			inspect: (): "alive" | "dead" | "unknown" => "unknown",
		}).sweep();
		expect(r.keptCurrent).toBe(1);
		expect(r.pruned.map((p) => p.file)).toEqual(["launch-ghost.json"]);
		expect(existsSync(join(dir, "launch-replaced.json"))).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("young files ride past the cutoff; the pause marker halts everything", () => {
		const dir = freshDir();
		seed(dir, "launch-young.json", DAY);
		const r = janitor({ dir, act: true }).sweep();
		expect(r.kept).toBe(1);
		expect(r.pruned).toEqual([]);
		writeFileSync(join(dir, LAUNCH_JANITOR_PAUSE_MARKER), "");
		seed(dir, "launch-old.json", 30 * DAY);
		const p = janitor({ dir, act: true }).sweep();
		expect(p.paused).toBe(true);
		expect(p.pruned).toEqual([]);
		expect(existsSync(join(dir, "launch-old.json"))).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("janitor bounds and edges (W1247)", () => {
	test("classifyGroups splits keeps from stale; kept counts files", () => {
		const dir = freshDir();
		seed(dir, "launch-a1.json", 30 * DAY);
		seed(dir, "launch-b2.json", DAY);
		seed(dir, "launch-cur.json", 30 * DAY);
		const groups = groupByNonce([
			"launch-a1.json",
			"launch-b2.json",
			"launch-cur.json",
		]);
		const split = classifyGroups(
			dir,
			groups,
			new Map([["cur", intent("cur")]]),
			(): "alive" | "dead" | "unknown" => "alive",
			NOW - 7 * DAY,
			(): number => NOW,
		);
		expect(split.kept).toBe(1);
		expect(split.keptCurrent).toBe(1);
		expect(split.stale.map((s) => s.nonce)).toEqual(["a1"]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("maxPrune bounds the batch; overflow stays on disk", () => {
		const dir = freshDir();
		seed(dir, "launch-a1.json", 30 * DAY);
		seed(dir, "launch-b2.json", 30 * DAY);
		seed(dir, "launch-c3.json", 30 * DAY);
		const r = janitor({ dir, act: true, maxPrune: 2 }).sweep();
		expect(r.pruned).toHaveLength(2);
		expect(r.overflow).toBe(1);
		expect(readdirSync(dir).sort()).toEqual(["launch-c3.json"]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("absent dir is a zeroed report; age rides the injected clock", () => {
		const r = janitor({ dir: join(freshDir(), "nope") }).sweep();
		expect(r).toEqual({
			dryRun: true,
			paused: false,
			scanned: 0,
			groups: 0,
			kept: 0,
			keptCurrent: 0,
			overflow: 0,
			pruned: [],
			errors: [],
		});
		const dir = freshDir();
		seed(dir, "launch-edge.json", 7 * DAY - 60_000);
		const r2 = janitor({ dir, now: (): number => NOW }).sweep();
		expect(r2.pruned).toEqual([]);
		seed(dir, "launch-edge2.json", 7 * DAY + 60_000);
		const r3 = janitor({ dir, now: (): number => NOW }).sweep();
		expect(r3.pruned.map((p) => p.file)).toEqual(["launch-edge2.json"]);
		rmSync(dir, { recursive: true, force: true });
	});
});
