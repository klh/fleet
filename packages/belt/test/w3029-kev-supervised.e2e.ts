// W3029 — the belt swarm supervisor owns kev (:8912): the registry row
// carries a spawn recipe, fleetTargets promotes it to an owned target, and
// the standalone com.belt.kev launchd unit is retired (no plist, boot-out
// list carries the label).
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BELT_SWARM_AGENT, EXTERNAL } from "../bin/registry.ts";
import { fleetTargets } from "../bin/supervisor.ts";

const kev = () => EXTERNAL.find((e) => e.port === 8912);

test.describe("kev is belt-supervised (W3029)", () => {
	test("registry row carries the spawn recipe, contract byte-stable @unit", () => {
		const row = kev();
		expect(row?.model).toBe("jaredpalmer/kev-4b");
		expect(row?.alias).toBe("local-kev");
		expect(row?.protocol).toBe("systemone");
		expect(row?.healthPath).toBe("/v1/models");
		expect(row?.launchdLabel).toBe(BELT_SWARM_AGENT);
		const argv = row?.supervise?.argv ?? [];
		expect(argv.at(-1)).toBe("8912");
		expect(argv).toContain("jaredpalmer/kev-4b");
		expect(argv).toContain("kev.serve");
		expect(row?.supervise?.env).toEqual({ KEV_DTYPE: "bf16" });
	});

	test("fleetTargets owns :8912 with a spawn + generation @unit", () => {
		const t = fleetTargets().find((x) => x.port === 8912);
		expect(t?.owned).toBe(true);
		expect(t?.kind).toBe("specialist");
		expect(typeof t?.spawn).toBe("function");
		expect(t?.killHung).toBe(false);
		expect(typeof t?.generation).toBe("string");
	});

	test("standalone com.belt.kev plist is retired @unit", () => {
		const dir = resolve(import.meta.dir, "../launchd");
		expect(existsSync(resolve(dir, "com.belt.kev.plist"))).toBe(false);
		const install = readFileSync(
			resolve(import.meta.dir, "../install.sh"),
			"utf8",
		);
		expect(install).toContain("com.belt.kev");
	});
});
