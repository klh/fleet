// test/legacy-sweep.test.ts — W783: the retired-label sweep is
// NAMESPACE-granular. A foreign label that appears in NO list still gets
// booted out + its plist rm'd, purely because it rides a retired namespace;
// live manifest labels and the exempt com.klh-local.* namespace survive. All
// launchd contact is injected — no test touches real launchd.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseLaunchctlListLabels,
	sweepLegacyLabels,
} from "../scripts/install-launchd.ts";
import {
	loadLegacySweep,
	matchLegacyLabel,
} from "../scripts/install-services.ts";

const SWEEP = {
	namespaces: [{ prefix: "com.klh.", except: ["com.klh-local."] }],
	labels: ["com.belt.swarm", "com.belt.gateway"],
};

const tmpAgents = (files: string[]): string => {
	const dir = mkdtempSync(join(tmpdir(), "legacy-sweep-"));
	for (const f of files)
		writeFileSync(join(dir, f), `<?xml version="1.0"?><plist/>`);
	return dir;
};

describe("matchLegacyLabel (W783 namespace granularity)", () => {
	test("a foreign label under a retired namespace matches", () => {
		expect(matchLegacyLabel("com.klh.brand-new-thing", SWEEP)).toBe(true);
	});

	test("the exempt namespace never matches", () => {
		expect(matchLegacyLabel("com.klh-local.caddy", SWEEP)).toBe(false);
	});

	test("explicit retired product labels match; their namespace does not", () => {
		expect(matchLegacyLabel("com.belt.swarm", SWEEP)).toBe(true);
		expect(matchLegacyLabel("com.belt.gateway", SWEEP)).toBe(true);
		expect(matchLegacyLabel("com.belt.dashboard", SWEEP)).toBe(false);
	});

	test("live namespaces never match", () => {
		expect(matchLegacyLabel("com.suspenders.board", SWEEP)).toBe(false);
		expect(matchLegacyLabel("com.apple.cfprefsd.xpc.agent", SWEEP)).toBe(false);
	});

	test("parseLaunchctlListLabels: third column, header and noise skipped", () => {
		expect(
			parseLaunchctlListLabels(
				"PID\tStatus\tLabel\n-\t0\tcom.klh.ghost\n127\t0\tcom.suspenders.board\n\ncom.belt.swarm",
			),
		).toEqual(["com.klh.ghost", "com.suspenders.board"]);
	});
});

describe("sweepLegacyLabels (W783)", () => {
	const run = async (files: string[], loaded: string[]) => {
		const dir = tmpAgents(files);
		const booted: string[] = [];
		const result = await sweepLegacyLabels({
			agentsDir: dir,
			domain: "gui/501",
			sweep: SWEEP,
			listLoaded: async () => loaded,
			bootout: async (label) => {
				booted.push(label);
			},
		});
		return { dir, booted, result };
	};

	test("sweep boots and rms a foreign label in a tmp LaunchAgents dir", async () => {
		const { dir, booted, result } = await run(
			["com.klh.zombie-agent.plist"],
			[],
		);
		expect(result.booted).toEqual(["com.klh.zombie-agent"]);
		expect(booted).toEqual(["com.klh.zombie-agent"]);
		expect(result.removed).toEqual(["com.klh.zombie-agent"]);
		expect(existsSync(join(dir, "com.klh.zombie-agent.plist"))).toBe(false);
	});

	test("manifest labels and the exempt namespace survive", async () => {
		const files = ["com.suspenders.board.plist", "com.klh-local.caddy.plist"];
		const { dir, booted, result } = await run(files, []);
		expect(booted).toEqual([]);
		expect(result.removed).toEqual([]);
		for (const f of files) expect(existsSync(join(dir, f))).toBe(true);
	});

	test("loaded-without-plist labels still boot out (launchctl list union)", async () => {
		const { dir, booted, result } = await run(
			[],
			["com.klh.ghost", "com.belt.gateway"],
		);
		expect(result.booted.sort()).toEqual(["com.belt.gateway", "com.klh.ghost"]);
		expect(booted.sort()).toEqual(["com.belt.gateway", "com.klh.ghost"]);
		expect(result.removed).toEqual([]);
		expect(existsSync(dir)).toBe(true);
	});
});

describe("manifest sweep table (W783)", () => {
	test("loader returns the declarative table from services.yaml", () => {
		const sweep = loadLegacySweep();
		expect(sweep.namespaces).toContainEqual({
			prefix: "com.klh.",
			except: ["com.klh-local."],
		});
		expect(sweep.labels).toContain("com.belt.swarm");
		expect(sweep.labels).toContain("com.belt.gateway");
	});

	test("the real table never matches a live rendered label", () => {
		const sweep = loadLegacySweep();
		expect(matchLegacyLabel("com.suspenders.belt-swarm", sweep)).toBe(false);
		expect(matchLegacyLabel("com.suspenders.board", sweep)).toBe(false);
	});

	test("loader refuses a prefix without a trailing dot", async () => {
		mkdirSync(tmpdir(), { recursive: true });
		const dir = mkdtempSync(join(tmpdir(), "legacy-sweep-bad-"));
		const manifest = join(dir, "services.yaml");
		writeFileSync(
			manifest,
			[
				"labelPrefix: com.suspenders",
				"legacySweep:",
				"  namespaces:",
				"    - prefix: com.klh",
				"  labels: []",
				"services:",
				"  - name: x",
				"    bunEntry: __BUN__",
				"    logs: { out: /tmp/x.log }",
				"    placeholders: ['__BUN__']",
			].join("\n"),
		);
		expect(() => loadLegacySweep(manifest)).toThrow(/dotted prefix/);
	});
});
