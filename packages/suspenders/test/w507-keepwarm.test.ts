// test/w507-keepwarm.test.ts — W507: llm-keepwarm warms the EMITTED tier
// manifest's warm_ports (no launchd tier env, no hardcoded port list). HOME
// redirect keeps the remotes-probe leg off the real machine config.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEPWARM = new URL("../hooks/bin/llm-keepwarm.ts", import.meta.url)
	.pathname;

describe("llm-keepwarm reads the tier manifest (W507)", () => {
	test("warms exactly warm_ports; fail-safe minimal when the manifest is gone", () => {
		const home = mkdtempSync(join(tmpdir(), "w507-kw-home-"));
		const dir = mkdtempSync(join(tmpdir(), "w507-kw-"));
		const manifest = join(dir, "tier.json");
		writeFileSync(
			manifest,
			JSON.stringify({ tier: "minimal", warm_ports: [8902] }),
		);
		const env = {
			...process.env,
			HOME: home,
			BELT_TIER_MANIFEST: manifest,
		};
		const hit = Bun.spawnSync(["bun", KEEPWARM], { env });
		expect(hit.exitCode).toBe(0);
		const out = hit.stdout.toString();
		expect(out).toContain(":8902");
		expect(out).not.toContain(":8901");
		expect(out).not.toContain(":8903");

		const missing = Bun.spawnSync(["bun", KEEPWARM], {
			env: { ...env, BELT_TIER_MANIFEST: "/tmp/w507-kein-manifest.json" },
		});
		expect(missing.exitCode).toBe(0);
		const missOut = missing.stdout.toString();
		expect(missOut).toContain(":8902");
		expect(missOut).toContain(":8913");
		expect(missOut).not.toContain(":8903");
	}, 20000);
});
