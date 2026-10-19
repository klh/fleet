// test/fleet-capabilities.test.ts — W918: evidence-backed capability catalog
// over the vendored skills registry. Honesty law under test: skills-dir
// detection and skill-installability are never runnable evidence.
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	capabilityCatalog,
	defaultBinProbe,
	targetCapabilities,
	type BinProbe,
} from "../hooks/lib/targets.ts";

const REPO = join(import.meta.dir, "..");

test("every catalog row exposes all six evidence states", async () => {
	const rows = await capabilityCatalog(REPO);
	expect(rows.length).toBe(78); // full vendored breadth minus 'universal'
	for (const row of rows) {
		expect(Object.keys(row.capabilities).sort()).toEqual([
			"buckleCompatible",
			"detected",
			"headlessSpawnable",
			"hookWired",
			"sessionResumable",
			"skillInstallable",
		]);
	}
});

test("skillInstallable holds for every catalog row", async () => {
	const rows = await capabilityCatalog(REPO);
	for (const row of rows) {
		expect(row.capabilities.skillInstallable).toBe(true);
	}
});

test("detection is NOT runnable evidence (honesty law)", () => {
	const cap = targetCapabilities("warp", REPO, true, () => true);
	expect(cap.detected).toBe(true);
	expect(cap.headlessSpawnable).toBe(false);
	expect(cap.sessionResumable).toBe(false);
	expect(cap.buckleCompatible).toBe("unknown");
});

test("adapter-backed targets expose verified states", () => {
	const probe: BinProbe = () => true;
	const claude = targetCapabilities("claude-code", REPO, true, probe);
	expect(claude.hookWired).toBe(true);
	expect(claude.headlessSpawnable).toBe(true);
	expect(claude.sessionResumable).toBe(true);
	expect(claude.buckleCompatible).toBe(true);
	const codex = targetCapabilities("codex", REPO, false, probe);
	expect(codex.headlessSpawnable).toBe(true);
	expect(codex.sessionResumable).toBe(false);
	// W918.2 landed proof: /w/<slug>/v1/responses token round-trip.
	expect(codex.buckleCompatible).toBe(true);
});

test("grok/cline catalog rows stay honest not-installed records", () => {
	const probe: BinProbe = () => true;
	for (const type of ["grok", "cline"] as const) {
		const cap = targetCapabilities(type, REPO, false, probe);
		// Never installed here, never lane-proven: even a passing binary
		// probe must not invent spawn/resume/buckle evidence.
		expect(cap.headlessSpawnable).toBe(false);
		expect(cap.sessionResumable).toBe(false);
		expect(cap.buckleCompatible).toBe("unknown");
	}
});

test("hookWired reflects on-disk wire.ts evidence", () => {
	const codex = targetCapabilities("codex", REPO, false);
	expect(codex.hookWired).toBe(true);
	const warp = targetCapabilities("warp", REPO, false);
	expect(warp.hookWired).toBe(false);
});

test("defaultBinProbe resolves bun, refuses nonsense", () => {
	expect(defaultBinProbe("bun")).toBe(true);
	expect(defaultBinProbe("definitely-not-a-binary-w918")).toBe(false);
});

test("fleet-install --capabilities prints the live catalog", () => {
	const r = Bun.spawnSync(
		["bun", "hooks/bin/fleet-install.ts", "--capabilities"],
		{
			cwd: REPO,
			encoding: "utf8",
			env: { ...process.env },
		},
	);
	const out = `${r.stdout ?? ""}`;
	expect(r.exitCode).toBe(0);
	expect(out).toContain("catalog targets");
	expect(out).toContain("Claude");
});
