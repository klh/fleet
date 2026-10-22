// test/fleet-capabilities.test.ts — W918: evidence-backed capability catalog
// over the vendored skills registry. Honesty law under test: skills-dir
// detection and skill-installability are never runnable evidence.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capabilityCatalog,
	defaultBinProbe,
	targetCapabilities,
	type BinProbe,
} from "../hooks/lib/targets.ts";

const REPO = join(import.meta.dir, "..");
// fixture home for the CLI smoke: detection inputs are pinned, never ambient
const HOME = mkdtempSync(join(tmpdir(), "suspenders-fleet-caps-"));

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("every catalog row exposes all seven evidence states", async () => {
	const rows = await capabilityCatalog(REPO);
	expect(rows.length).toBe(78); // full vendored breadth minus 'universal'
	for (const row of rows) {
		expect(Object.keys(row.capabilities).sort()).toEqual([
			"buckleCompatible",
			"detected",
			"headlessSpawnable",
			"hookRegistration",
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

test("capability catalog distinguishes adapter availability from registration", async () => {
	const rows = await capabilityCatalog(REPO);
	const zcode = rows.find((row) => row.type === "zcode");
	expect(zcode?.capabilities.hookWired).toBe(false);
	if (zcode?.installed)
		expect(zcode.capabilities.hookRegistration).toBe("unsupported");
	const absent = rows.find((row) => row.type === "grok");
	if (absent && !absent.installed)
		expect(absent.capabilities.hookRegistration).toBe("not-detected");
});

test("defaultBinProbe resolves bun, refuses nonsense", () => {
	expect(defaultBinProbe("bun")).toBe(true);
	expect(defaultBinProbe("definitely-not-a-binary-w918")).toBe(false);
});

test("fleet-install --capabilities prints the live catalog", () => {
	// hermetic child: CLAUDE_CONFIG_DIR pins the one detection input this smoke
	// depends on — the suite shares one process, so an ambient fixture HOME
	// (or a bare machine) must not zero the detection (W1124.11). The honesty
	// law still holds: this asserts the CLI PRINTS the catalog row, not that
	// any capability is runnable — states stay covered by the tests above.
	mkdirSync(join(HOME, ".claude"), { recursive: true });
	const r = Bun.spawnSync(
		["bun", "hooks/bin/fleet-install.ts", "--capabilities"],
		{
			cwd: REPO,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: HOME,
				CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
			},
		},
	);
	const out = `${r.stdout ?? ""}`;
	expect(r.exitCode).toBe(0);
	expect(out).toContain("catalog targets");
	expect(out).toContain("Claude");
});
