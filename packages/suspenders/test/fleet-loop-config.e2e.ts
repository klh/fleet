// test/fleet-loop-config.e2e.ts — W2173.7 the loop config is zod-first
// (LoopConfigSchema is THE definition; the type is derived) and the loop's
// error kit carries stable `loop.*` codes rendered by loopDie/describeError.
import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LoopConfigSchema,
	parseLoopConfig,
} from "../hooks/lib/fleet-loop/config.ts";
import {
	LoopError,
	describeError,
} from "../hooks/lib/fleet-loop/loop-errors.ts";

const tmpRepo = (): string => mkdtempSync(join(tmpdir(), "w2173-7-config-"));
const LOOP = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");

test.describe("LoopConfigSchema (W2173.7) @unit", () => {
	test("parseLoopConfig output parses against the schema", () => {
		const c = parseLoopConfig(["once", "--repo", tmpRepo()], "/x/bin");
		expect(c.MODE).toBe("once");
		expect(c.FAILS).toBe(join(c.REPO, ".fleet", "merge-fails.json"));
		expect(LoopConfigSchema.safeParse(c).success).toBe(true);
	});

	test("unknown mode dies loop.usage on stderr, exit 1", () => {
		const p = Bun.spawnSync([
			process.execPath,
			LOOP,
			"bogus",
			"--repo",
			tmpRepo(),
		]);
		expect(p.exitCode).toBe(1);
		expect(p.stderr.toString()).toContain("loop.usage:");
	});

	test("valueless --repo dies loop.config_invalid", () => {
		const p = Bun.spawnSync([process.execPath, LOOP, "once", "--repo"]);
		expect(p.exitCode).toBe(1);
		expect(p.stderr.toString()).toContain("loop.config_invalid:");
	});

	test("LoopError carries its code through describeError", () => {
		const e = new LoopError("loop.ship_veto", "mid-flight");
		expect(describeError(e)).toBe("loop.ship_veto: mid-flight");
		expect(describeError(new Error("plain"))).toBe("plain");
	});
});
