// fleet-loop-unit-no-target@unit.e2e.ts — hub design D4 (2026-10-29): the
// installed com.suspenders.fleet-loop unit carried `--target 20` in its argv
// (and in --dispatch-cmd), overriding stack.json fleet_loop.lane_target=8.
// The cap is config-over-code (W2242: fleet-loop appends the live
// lane_target when the template names none); --target stays an explicit
// operator override only. Every rendered fleet-loop unit — the services
// manifest on all three targets and the launchd template — must carry none.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultRenderValues,
	loadManifest,
	renderUnits,
	TEMPLATE_DIR,
} from "../scripts/install/install-services.ts";

const spec = loadManifest().find((s) => s.name === "fleet-loop");

test("services manifest fleet-loop argv names no --target", () => {
	expect(spec).toBeTruthy();
	expect(JSON.stringify(spec)).not.toContain("--target");
});

for (const target of ["darwin", "linux", "win32"]) {
	test(`rendered ${target} fleet-loop unit carries no hard-coded --target`, () => {
		const values = defaultRenderValues({ home: "/home/u", repo: "/r" });
		const bodies = renderUnits(target, spec ?? loadManifest()[0], values);
		for (const u of bodies) expect(u.body).not.toMatch(/--target\b/);
	});
}

test("launchd template fleet-loop plist carries no hard-coded --target", () => {
	const plist = readFileSync(
		join(TEMPLATE_DIR, "com.suspenders.fleet-loop.plist"),
		"utf8",
	);
	expect(plist).not.toMatch(/--target\b/);
	expect(plist).toContain("dispatch-next.ts");
});
