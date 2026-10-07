import { expect, test } from "bun:test";
import { beltPage, localPage } from "../hooks/bin/console-html.ts";
import { displayLabel, fleetNav, FLEET_ICONS } from "../hooks/lib/theme.ts";

test("every surface receives the same monochrome menu destinations", () => {
	const menus = ["belt", "suspenders", "local"].map((site) =>
		fleetNav(site as "belt" | "suspenders" | "local"),
	);
	for (const menu of menus) {
		for (const label of [
			"Models",
			"Gateway",
			"Workflows",
			"Services",
			"Metrics",
		])
			expect(menu).toContain(`<span>${label}</span>`);
		expect(menu.match(/<svg /g)).toHaveLength(5);
	}
	for (const icon of Object.values(FLEET_ICONS))
		expect(icon).not.toMatch(/#[0-9a-f]{3,8}/i);
	expect(displayLabel("🧠 reason · model-name")).toBe("reason · model-name");
});
test("gateway has transports while local services starts with route registry", () => {
	const probes = ["buckle-4101", "swarm-8901", "suspenders-board"].map(
		(id) => ({
			id,
			name: id,
			port: 1,
			state: "up" as const,
			up: true,
			detail: "HTTP200",
			probed_at: new Date().toISOString(),
			recovery: null,
		}),
	);
	const gateway = beltPage({
		policy: null,
		gateway: null,
		policyError: null,
		beltApi: null,
		health: probes,
		groups: null,
	});
	expect(gateway).toContain('data-service="buckle-4101"');
	expect(gateway).not.toContain('data-service="swarm-8901"');
	expect(gateway).not.toContain('data-service="suspenders-board"');
	const local = localPage({
		services: [
			{
				name: "nas-hub",
				port: 7799,
				upstream: "nas.example:7799",
				created: "",
			},
		],
		regPath: "registry.json",
		error: null,
		probes,
		source: "probes+registry",
	});
	expect(local.indexOf("Registered services · 1")).toBeLessThan(
		local.indexOf("Local machine ·"),
	);
	expect(local).toContain("Remote upstream");
	expect(local).toContain('data-service="swarm-8901"');
});
