// test/artifact-bench@unit.e2e.ts — W2904 decision-grade properties over the
// replay-fixture driver (CI-safe: bun-only, no Docker). The fixtures are
// harness mechanics only, clearly labeled, never ledger rows.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	dockerDriver,
	dockerImageIdentity,
} from "../bench/artifact/docker-driver.ts";
import { replayFixtureDriver, walkOrder } from "../bench/artifact/drivers.ts";
import {
	audit,
	coldStartSpec,
	type Receipt,
	receiptLines,
	replayReceipts,
	runScenario,
} from "../bench/artifact/harness.ts";
import {
	type ArmRef,
	type ArmSamples,
	type Caps,
	computeVerdict,
	type ScenarioSpec,
	seededOrder,
	statOf,
} from "../bench/artifact/types.ts";

const CAPS: Caps = {
	bed: "docker-desktop",
	host: "linuxkit",
	kernel: "7.0.14",
	arch: "arm64",
	cpu: 18,
	memMiB: 7889,
};

const ARMS: ArmRef[] = [
	{ kind: "image", id: "alpine:3.21", label: "alpine", pinned: false },
	{ kind: "image", id: "debian:bookworm-slim", label: "debian", pinned: false },
	{ kind: "image", id: "fedora:41", label: "fedora", pinned: false },
];

// fixture schedule (ms) — medians: alpine 171, debian 171 (tied), fedora 196.
const FIXTURES: Record<string, number[]> = {
	"alpine:3.21": [168, 171, 170, 173, 169, 172, 171],
	"debian:bookworm-slim": [170, 169, 173, 171, 172, 168, 171],
	"fedora:41": [194, 197, 196, 195, 198, 196, 194],
};

const SPEC: ScenarioSpec = coldStartSpec(ARMS);

test.describe("artifact bench decision kernel @unit", () => {
	test("median lowerWins picks the strictly best arm with margin", () => {
		const arms: ArmSamples[] = [
			{ arm: "fast", samples: [10, 11, 12] },
			{ arm: "slow", samples: [20, 21, 22] },
		];
		const v = computeVerdict(arms, {
			stat: "median",
			lowerWins: true,
			tieEpsilon: 0.05,
		});
		expect(v.winner).toBe("fast");
		expect(v.best).toBe(11);
		expect(v.marginRel !== null && v.marginRel > 0.4).toBe(true);
	});

	test("inside the tieEpsilon band the verdict is the explicit tie", () => {
		const arms: ArmSamples[] = [
			{ arm: "a", samples: [100, 101, 102] },
			{ arm: "b", samples: [101, 102, 103] },
		];
		const v = computeVerdict(arms, {
			stat: "median",
			lowerWins: true,
			tieEpsilon: 0.05,
		});
		expect(v.winner).toBe("tied");
		expect(v.tiedArms.sort()).toEqual(["a", "b"]);
		expect(v.best).toBeNull();
	});

	test("just outside the band a winner is named", () => {
		const arms: ArmSamples[] = [
			{ arm: "a", samples: [100, 100, 100] },
			{ arm: "b", samples: [110, 110, 110] },
		];
		const v = computeVerdict(arms, {
			stat: "median",
			lowerWins: true,
			tieEpsilon: 0.05,
		});
		expect(v.winner).toBe("a");
	});

	test("statOf: median even/odd and p95 upper bound", () => {
		expect(statOf([3, 1, 2], "median")).toBe(2);
		expect(statOf([1, 2, 3, 4], "median")).toBe(2.5);
		expect(statOf([10, 20, 30, 40, 50, 60, 100], "p95")).toBe(100);
	});

	test("seededOrder: deterministic, a permutation, seed-sensitive", () => {
		expect(seededOrder(5, 42)).toEqual(seededOrder(5, 42));
		expect([...seededOrder(5, 42)].sort((a, b) => a - b)).toEqual([
			0, 1, 2, 3, 4,
		]);
		expect(seededOrder(5, 43)).not.toEqual(seededOrder(5, 42));
	});
});

test.describe("artifact bench harness @unit", () => {
	test("runScenario emits receipts + REQUIRED verdict; alpine/debian tie, fedora loses", async () => {
		const driver = replayFixtureDriver(CAPS, FIXTURES);
		const run = await runScenario(SPEC, driver);
		expect(run.summary.verdict.winner).toBe("tied");
		expect(run.summary.verdict.tiedArms.sort()).toEqual([
			"alpine:3.21",
			"debian:bookworm-slim",
		]);
		expect(run.summary.stats["fedora:41"]?.median).toBe(196);
		expect(run.failures.length).toBe(0);
		expect(run.summary.stats["alpine:3.21"]).toEqual({ median: 171, p95: 173 });
		const auditRows = audit(run, SPEC);
		for (const row of auditRows) expect(row.ok).toBe(true);
		const duplicate = {
			...run,
			armReceipts: [run.armReceipts[1], ...run.armReceipts.slice(1)],
		};
		expect(audit(duplicate, SPEC)).toContainEqual({
			prop: "reps-accounted",
			ok: false,
		});
	});

	test("replay rejects changed statistics and duplicated trials", async () => {
		const run = await runScenario(SPEC, replayFixtureDriver(CAPS, FIXTURES));
		const lines = receiptLines(run);
		expect(replayReceipts(lines.join("\n")).summary).toEqual(run.summary);
		const wrong = { ...run.summary, stats: {} };
		expect(() =>
			replayReceipts([...lines.slice(0, -1), JSON.stringify(wrong)].join("\n")),
		).toThrow();
		expect(() =>
			replayReceipts([lines[1], ...lines.slice(1)].join("\n")),
		).toThrow();
	});

	test("byte-identical receipts for the same seed + schedule", async () => {
		const a = receiptLines(
			await runScenario(SPEC, replayFixtureDriver(CAPS, FIXTURES)),
		);
		const b = receiptLines(
			await runScenario(SPEC, replayFixtureDriver(CAPS, FIXTURES)),
		);
		expect(a).toEqual(b);
	});

	test("walk order covers every arm×rep exactly once", () => {
		const walk = walkOrder(ARMS, 7, SPEC.seed);
		expect(walk.length).toBe(21);
		const seen = new Set(walk.map((w) => `${w.arm.id}@${w.rep}`));
		expect(seen.size).toBe(21);
	});

	test("failures are recorded verbatim and starve only that arm", async () => {
		const driver = replayFixtureDriver(CAPS, {
			"alpine:3.21": [170],
			"debian:bookworm-slim": [171],
		});
		const run = await runScenario(SPEC, driver);
		expect(run.failures.length).toBeGreaterThan(0);
		expect(run.summary.stats["alpine:3.21"]).toBeDefined();
		expect(run.summary.stats["fedora:41"]).toBeUndefined();
		const auditRows = audit(run, SPEC);
		expect(auditRows.find((r) => r.prop === "verdict-decides")?.ok).toBe(true);
	});

	test("receipt JSONL round-trips through parse", async () => {
		const lines = receiptLines(
			await runScenario(SPEC, replayFixtureDriver(CAPS, FIXTURES)),
		);
		const parsed = lines.map((l) => JSON.parse(l) as Receipt);
		const summary = parsed.find((r) => r.kind === "scenario-summary");
		expect(
			summary && "verdict" in summary && summary.verdict.winner === "tied",
		).toBe(true);
	});
});

test("Docker probe checks native identity, ready output and cleanup @unit", async () => {
	const world = scratchWorld({ prefix: "blam-docker-probe-" });
	try {
		const binary = join(world.home, "docker");
		const log = join(world.home, "argv");
		const mode = join(world.home, "mode");
		writeFileSync(
			binary,
			`#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = readFileSync(${JSON.stringify(mode)}, "utf8");
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + String.fromCharCode(10));
if (args[0] === "image") console.log("linux/amd64|sha256:" + "a".repeat(64));
if (args[0] === "start") {
	if (mode === "ok") {
		process.stdout.write("re");
		await Bun.sleep(5);
		process.stdout.write("ady" + String.fromCharCode(10));
	}
	if (mode === "large") console.log("x".repeat(4097));
	if (mode === "timeout") await Bun.sleep(3000);
}
if (args[0] === "rm" && mode === "both") {
	console.error("fixture cleanup failed");
	process.exit(9);
}
`,
			{ mode: 0o700 },
		);
		const driver = dockerDriver(CAPS, { binary, deadlineMs: 500 });
		writeFileSync(mode, "ok");
		await expect(dockerImageIdentity(CAPS, ARMS[0].id, binary)).rejects.toThrow(
			"linux/arm64",
		);
		expect(await driver.measure(ARMS[0], 0, 1)).toBeGreaterThanOrEqual(0);
		for (const [behavior, error] of [
			["missing", /ready marker/],
			["large", /4096 bytes/],
			["timeout", /ready marker/],
			["both", /ready marker.*Docker cleanup failed/],
		] as const) {
			writeFileSync(mode, behavior);
			await expect(driver.measure(ARMS[0], 0, 1)).rejects.toThrow(error);
		}
		const calls: string[][] = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse);
		const creates = calls.filter(([verb]) => verb === "create");
		const names = creates.map((args) => args[args.indexOf("--name") + 1]);
		expect(new Set(names).size).toBe(5);
		for (const name of names) expect(calls).toContainEqual(["rm", "-f", name]);
		for (const argv of creates) {
			expect(argv).toContain("linux/arm64");
			expect(argv).toContain("never");
		}
	} finally {
		world.clean();
	}
});
