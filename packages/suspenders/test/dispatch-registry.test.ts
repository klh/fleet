// test/dispatch-registry.test.ts — W636: the dispatch registry verb family
// (list/prune/forget). Covered: the pure prune classification, the locked
// deletion authority (guard re-verified under lock), and the CLI end to end
// with the REAL liveness verdict on deterministic rows (pid-less row on this
// host reads dead; foreign-host row without transcript reads unknown), plus
// the router wiring through the dispatch entrypoint itself.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeLaneRegistry,
	pruneLaneRegistry,
	readLaneRegistry,
} from "../hooks/lib/lane-registry.ts";
import { classifyPrune, registryMain } from "../scripts/lib/registry-cli.ts";
import type { Lane } from "../scripts/lib/lane.ts";

setDefaultTimeout(30_000);

const roots: string[] = [];
const fleetOf = (): string => {
	const root = mkdtempSync(join(tmpdir(), "w636-registry-"));
	roots.push(root);
	return join(root, ".fleet");
};

const row = (sid: string, over: Partial<Lane> = {}): Lane => ({
	sid,
	item: "W636",
	pid: 0,
	branch: "suspenders/W636",
	worktree: "/unused",
	launchedAt: 1,
	...over,
});

const capture = async (
	fn: () => number | Promise<number>,
): Promise<{ lines: string[]; code: number }> => {
	const buf: string[] = [];
	const orig = console.log;
	console.log = (...a: unknown[]) => buf.push(a.join(" "));
	try {
		const code = await fn();
		return { lines: buf, code };
	} finally {
		console.log = orig;
	}
};

describe("classifyPrune", () => {
	test("dead prunes, live/unknown refuse, absent no-ops", () => {
		const verdicts = new Map([
			["d", "dead"],
			["l", "alive"],
			["u", "unknown"],
		] as const);
		const plan = classifyPrune(
			[row("d"), row("l"), row("u")],
			["d", "l", "u", "gone"],
			(l) => verdicts.get(l.sid) ?? "unknown",
		);
		expect(plan.get("d")?.class).toBe("prunable");
		expect(plan.get("l")?.class).toBe("refused-live");
		expect(plan.get("u")?.class).toBe("refused-unknown");
		expect(plan.get("gone")?.class).toBe("absent");
	});
});

describe("pruneLaneRegistry", () => {
	test("removes only guard-passing requested sids, keeps the rest", () => {
		const fleet = fleetOf();
		mergeLaneRegistry(fleet, [row("keep-a"), row("drop-b"), row("keep-c")]);
		const result = pruneLaneRegistry<Lane>(
			fleet,
			["drop-b", "nope"],
			(r) => r.sid === "drop-b",
		);
		expect(result.removed.map((r) => r.sid)).toEqual(["drop-b"]);
		expect(readLaneRegistry<Lane>(fleet).lanes.map((r) => r.sid)).toEqual([
			"keep-a",
			"keep-c",
		]);
	});

	test("guard refusal, empty request and absent registry are safe no-ops", () => {
		const fleet = fleetOf();
		mergeLaneRegistry(fleet, [row("a"), row("b")]);
		const before = readFileSync(join(fleet, "lanes.json"), "utf8");
		expect(
			pruneLaneRegistry<Lane>(fleet, ["a"], () => false).removed,
		).toHaveLength(0);
		expect(pruneLaneRegistry<Lane>(fleet, [], () => true).removed).toHaveLength(
			0,
		);
		expect(readFileSync(join(fleet, "lanes.json"), "utf8")).toBe(before);
		expect(
			pruneLaneRegistry<Lane>(fleetOf(), ["x"], () => true).removed,
		).toHaveLength(0);
	});

	test("refuses a corrupt registry", () => {
		const fleet = fleetOf();
		mkdirSync(fleet, { recursive: true });
		writeFileSync(join(fleet, "lanes.json"), "truncated {");
		expect(() => pruneLaneRegistry<Lane>(fleet, ["a"], () => true)).toThrow(
			"unreadable",
		);
	});
});

describe("registry CLI (real liveness verdict)", () => {
	test("prunes a provably-dead pid-less entry on this host", async () => {
		const fleet = fleetOf();
		const sid = `autow636-dead-${Math.random().toString(36).slice(2, 8)}`;
		mergeLaneRegistry(fleet, [row(sid), row("stayer")]);
		const out = await capture(() =>
			registryMain(["prune", "--sid", sid, "stayer"], { fleet }),
		);
		expect(out.lines.join("\n")).toContain(
			`PRUNED ${sid} — dead lane entry (item W636)`,
		);
		const left = readLaneRegistry<Lane>(fleet).lanes.map((r) => r.sid);
		expect(left).toEqual(["stayer"]);
	});

	test("retains a foreign-host entry: exit 1, unknown, row untouched", async () => {
		const fleet = fleetOf();
		const sid = `autow636-remote-${Math.random().toString(36).slice(2, 8)}`;
		mergeLaneRegistry(fleet, [row(sid, { host: "elsewhere.example" })]);
		const r = await capture(() =>
			registryMain(["prune", "--sid", sid], { fleet }),
		);
		expect(r.code).toBe(1);
		expect(r.lines.join("\n")).toContain(
			`RETAINED ${sid} — unknown liveness (probe uncertain; never force-pruned)`,
		);
		expect(readLaneRegistry<Lane>(fleet).lanes).toHaveLength(1);
	});

	test("dry-run reports without writing; forget is a prune alias", async () => {
		const fleet = fleetOf();
		const sid = `autow636-dry-${Math.random().toString(36).slice(2, 8)}`;
		mergeLaneRegistry(fleet, [row(sid)]);
		const dry = await capture(() =>
			registryMain(["prune", "--sid", sid, "--dry-run"], { fleet }),
		);
		expect(dry.code).toBe(0);
		expect(dry.lines.join("\n")).toContain(`WOULD PRUNE ${sid} — prunable`);
		expect(readLaneRegistry<Lane>(fleet).lanes).toHaveLength(1);
		const gone = await capture(() =>
			registryMain(["forget", "--sid", sid], { fleet }),
		);
		expect(gone.code).toBe(0);
		expect(readLaneRegistry<Lane>(fleet).lanes).toHaveLength(0);
	});

	test("list --json prints entries with verdicts", async () => {
		const fleet = fleetOf();
		mergeLaneRegistry(fleet, [row("lst-1")]);
		const r = await capture(() => registryMain(["list", "--json"], { fleet }));
		expect(r.code).toBe(0);
		const parsed = JSON.parse(r.lines[0]) as Array<{
			sid: string;
			verdict: string;
		}>;
		expect(parsed.map((x) => x.sid)).toEqual(["lst-1"]);
		expect(parsed[0].verdict).toBe("dead");
	});

	test("usage verbs exit 2; NO ENTRY is a clean no-op", async () => {
		const fleet = fleetOf();
		expect((await capture(() => registryMain([], { fleet }))).code).toBe(2);
		expect((await capture(() => registryMain(["bogus"], { fleet }))).code).toBe(
			2,
		);
		const miss = await capture(() =>
			registryMain(["prune", "--sid", "ghost"], { fleet }),
		);
		expect(miss.code).toBe(0);
		expect(miss.lines.join("\n")).toContain("NO ENTRY ghost");
	});
});

describe("router wiring", () => {
	test("dispatch-next.ts registry prune runs the verb end to end", () => {
		const root = mkdtempSync(join(tmpdir(), "w636-router-"));
		roots.push(root);
		const fleet = join(root, ".fleet");
		const sid = `autow636-spawn-${Math.random().toString(36).slice(2, 8)}`;
		mergeLaneRegistry(fleet, [row(sid)]);
		const p = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
				"registry",
				"prune",
				"--sid",
				sid,
				"--repo",
				root,
			],
			{ stdout: "pipe", stderr: "pipe", env: { ...process.env } },
		);
		expect(p.exitCode).toBe(0);
		expect(p.stdout.toString()).toContain(`PRUNED ${sid}`);
		expect(readLaneRegistry<Lane>(fleet).lanes).toHaveLength(0);
	});
});

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
