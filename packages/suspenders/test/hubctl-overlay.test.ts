// test/hubctl-overlay.test.ts — W688.3: the overlay code-loader knobs are
// machine config (stack.yaml hub.overlay), materialized by hubctl render as
// HUB_KLH_OVERLAY_* .env knobs (the compose template maps them to the
// buckle-hub container's KLH_OVERLAY_* env; empty = unset = solo posture).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-overlay-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const deployDir = join(dir, "hub");
mkdirSync(deployDir);
const stack = join(dir, "stack.json");
await Bun.write(
	stack,
	JSON.stringify({
		version: "v1-w6883",
		hubs: {
			ov: {
				host: "127.0.0.1",
				overlay: {
					dir: "/src/fleet/packages/buckle-remote/src",
					sha256: "a".repeat(64),
					allow: "/src/fleet/packages",
				},
				deploy: { dir: deployDir },
			},
			solo: { host: "127.0.0.1", deploy: { dir: deployDir } },
		},
	}),
);

function hubctl(verb: string, hub: string) {
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), verb, hub],
		{
			env: { ...process.env, KLH_STACK: stack },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
}

describe("hubctl render — overlay knobs (W688.3)", () => {
	test("overlay hub renders HUB_KLH_OVERLAY_* into the .env", () => {
		const r = hubctl("render", "ov");
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			"HUB_KLH_OVERLAY_DIR=/src/fleet/packages/buckle-remote/src",
		);
		expect(r.out).toContain(`HUB_KLH_OVERLAY_SHA256=${"a".repeat(64)}`);
		expect(r.out).toContain("HUB_KLH_OVERLAY_ALLOW=/src/fleet/packages");
	});
	test("solo hub renders none of the overlay knobs", () => {
		const r = hubctl("render", "solo");
		expect(r.code).toBe(0);
		expect(r.out).not.toContain("HUB_KLH_OVERLAY");
	});
});
