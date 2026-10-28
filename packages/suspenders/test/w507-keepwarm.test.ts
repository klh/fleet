// test/w507-keepwarm.test.ts — W507: llm-keepwarm warms the EMITTED tier
// manifest's warm_ports (no launchd tier env, no hardcoded port list). HOME
// redirect keeps the remotes-probe leg off the real machine config.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
		// warmTargets maps warm_ports → aliases through the direct-tiers
		// catalog under HOME — seed one 8902 row or every port is disjoint.
		mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "local-llm", "direct-tiers.json"),
			JSON.stringify({ "kit-coder": "http://127.0.0.1:8902/v1" }),
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
			env: {
				...env,
				BELT_TIER_MANIFEST: join(
					tmpdir(),
					`w507-kein-manifest-${process.pid}.json`,
				),
			},
		});
		expect(missing.exitCode).toBe(0);
		const missOut = missing.stdout.toString();
		// W1119: a missing/unreadable manifest warms NOTHING this pass —
		// under-warming heals in one pass, warming past the manifest cannot.
		expect(missOut).not.toContain(":8902");
		expect(missOut).not.toContain(":8913");
	}, 20000);
});
