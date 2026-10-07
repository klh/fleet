import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	compareVersions,
	runtimeFacts,
	sqliteVerdict,
} from "../deploy/runtime-info.ts";

const SCRIPT = join(import.meta.dir, "../deploy/runtime-info.ts");

test("compareVersions orders patch/minor/major", () => {
	expect(compareVersions("3.51.3", "3.51.2")).toBeGreaterThan(0);
	expect(compareVersions("3.51.3", "3.51.3")).toBe(0);
	expect(compareVersions("3.44.6", "3.51.3")).toBeLessThan(0);
	expect(compareVersions("3.51", "3.51.0")).toBe(0);
});

test("sqliteVerdict: fix version verified, below requires evidence", () => {
	expect(sqliteVerdict("3.53.2").verified).toBe(true);
	expect(sqliteVerdict("3.51.3").verified).toBe(true);
	expect(sqliteVerdict("3.51.0").verified).toBe(false);
	expect(
		sqliteVerdict("3.50.7", "3.51.3", "vendor backport 3.50.7").verified,
	).toBe(true);
	expect(sqliteVerdict("3.51.0").reason).toContain("no backport evidence");
});

test("runtimeFacts reads the embedded sqlite identity", () => {
	const f = runtimeFacts();
	expect(f.bun).toBe(Bun.version);
	expect(f.sqlite).toMatch(/^\d+\.\d+\.\d+$/);
	expect(f.sourceId.length).toBeGreaterThan(0);
});

test("--json prints exactly one JSON line", () => {
	const r = Bun.spawnSync([process.execPath, SCRIPT, "--json"], {
		stdout: "pipe",
	});
	const lines = r.stdout.toString().trim().split("\n");
	expect(lines).toHaveLength(1);
	const j = JSON.parse(lines[0]) as { sqlite: string; verified: boolean };
	expect(j.sqlite).toMatch(/^\d+\.\d+\.\d+$/);
});

test("--check exits 0 at min, 1 below without evidence", () => {
	const ok = Bun.spawnSync(
		[process.execPath, SCRIPT, "--check", "--json", "--min", "3.44.0"],
		{ stdout: "pipe" },
	);
	expect(ok.exitCode).toBe(0);
	const bad = Bun.spawnSync(
		[process.execPath, SCRIPT, "--check", "--min", "99.0.0"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(bad.exitCode).toBe(1);
	// human mode: the verdict rides stdout; stderr only in --json mode
	expect(bad.stdout.toString()).toContain("UNVERIFIED");
});
