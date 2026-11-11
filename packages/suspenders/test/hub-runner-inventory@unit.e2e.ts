import { resolveWorkerInventoryOrigin } from "@klh/buckle/src/worker-inventory.ts";
import { fromLegacyProfile, HubSchema, toLegacyProfile } from "@klh/settings";
import { expect, test } from "@playwright/test";
import { renderEnv } from "../deploy/hub-env-render.ts";

test("hub inventory is opt-in and only targets a distinct loopback port @unit", () => {
	const hub = { host: "desktop.example", buckle_port: 4111 };
	const configured = { ...hub, runner_inventory_port: 7810 };
	const projected = HubSchema.parse(fromLegacyProfile(configured).hub);
	expect(toLegacyProfile(projected).runner_inventory_port).toBe(7810);
	expect(() =>
		renderEnv(
			{ ...hub, runner_inventory_port: 4111 },
			"fixture",
			undefined,
			"v2.1.4",
		),
	).toThrow("must differ");
	expect(renderEnv(hub, "fixture", undefined, "v2.1.4")).not.toContain(
		"HUB_RUNNER_INVENTORY_PORT",
	);
	expect(
		renderEnv(
			{ ...hub, runner_inventory_port: 7810 },
			"fixture",
			undefined,
			"v2.1.4",
		),
	).toContain("HUB_RUNNER_INVENTORY_PORT=7810");
	expect(resolveWorkerInventoryOrigin(4111, "7810", undefined)).toBe(
		"http://127.0.0.1:7810",
	);
	expect(resolveWorkerInventoryOrigin(4111, "", undefined)).toBeUndefined();
	for (const invalid of ["0", "65536", "4111", "host.docker.internal:7810"])
		expect(() =>
			resolveWorkerInventoryOrigin(4111, invalid, undefined),
		).toThrow();
	expect(() =>
		resolveWorkerInventoryOrigin(4111, undefined, "http://[::1]:4111"),
	).toThrow();
});
