import { expect, test } from "bun:test";
import { beltPage, localPage } from "../hooks/bin/console-html.ts";
import { displayLabel, fleetNav, FLEET_ICONS } from "../hooks/lib/theme.ts";

test("every surface receives the same monochrome menu destinations", () => {
	const menus = ["belt", "suspenders", "local"].map((site) =>
		fleetNav(site as "belt" | "suspenders" | "local"),
	);
	for (const menu of menus) {
		expect(menu).toContain(
			'<a href="https://suspenders.local/console/buckle" data-repo="https://github.com/klh/fleet/tree/main/packages/buckle"',
		);
		for (const label of [
			"Models",
			"Routes",
			"Workflows",
			"Services",
			"Metrics",
			"Hub",
			"Settings",
		])
			expect(menu).toContain(`<span>${label}</span>`);
		expect(menu.match(/<svg /g)).toHaveLength(7);
	}
	for (const icon of Object.values(FLEET_ICONS))
		expect(icon).not.toMatch(/#[0-9a-f]{3,8}/i);
	expect(displayLabel("🧠 reason · model-name")).toBe("reason · model-name");
});
test("gateway and local consoles show live status before configuration", () => {
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

		health: probes,
		groups: null,
	});
	expect(gateway).toContain('data-service="buckle-4101"');
	expect(gateway).not.toContain('data-service="swarm-8901"');
	expect(gateway).not.toContain('data-service="suspenders-board"');
	expect(gateway.indexOf("Gateway transports")).toBeLessThan(
		gateway.indexOf("Routing configuration"),
	);
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
	expect(local.indexOf("Local machine ·")).toBeLessThan(
		local.indexOf("Registered .local routes · 1"),
	);
	expect(local).toContain("Remote upstream");
	expect(local).toContain('data-service="swarm-8901"');
});

test("console card hosts carry esc(JSON) slices the components upgrade (W669.11)", () => {
	const probe = (id: string, up: boolean) => ({
		id,
		name: id,
		port: 1,
		state: up ? ("up" as const) : ("down" as const),
		up,
		detail: "HTTP200",
		probed_at: new Date().toISOString(),
		recovery: null,
	});
	const attr = (tag: string, page: string) =>
		page.match(new RegExp(`<${tag}[^>]*data="([^"]*)"`))?.[1] ?? "";
	const j = (s: string) => JSON.parse(s.replaceAll("&quot;", '"'));
	// the belt policy card: full slice in the data attr + the cards bundle tag
	const gw = {
		num_retries: 2,
		allowed_fails: 4,
		cooldown_time: 45,
		fallbacks: { "glm-5.3-flash": ["local-swarm", "gpt-5.2"] },
	};
	const gateway = beltPage({
		policy: {
			path: "/tmp/policy.yaml",
			source: "env",
			gateway: gw,
		},
		gateway: gw,
		policyError: null,

		health: [probe("buckle-4101", true)],
		groups: [{ name: "flash", tiers: 3, dormant: false }],
		upstreamSource: "fleet default + machine override",
	});
	const policy = j(attr("klh-policy-card", gateway)) as {
		kind: string;
		gateway: { fallbacks: Record<string, string[]> };
	};
	expect(policy.kind).toBe("policy");
	expect(policy.gateway.fallbacks["glm-5.3-flash"]).toEqual([
		"local-swarm",
		"gpt-5.2",
	]);
	expect(gateway).toContain('heading="Routing policy"');
	expect(gateway).toContain("/vendor/klh-console-cards.js");
	const upstreams = j(attr("klh-upstreams-card", gateway)) as {
		source: string;
		groups: { name: string; tiers: number; dormant: boolean }[] | null;
	};
	expect(upstreams.source).toBe("fleet default + machine override");
	expect(upstreams.groups?.[0]).toEqual({
		name: "flash",
		tiers: 3,
		dormant: false,
		source: "configured",
	});
	// null groups survives the JSON round-trip (the card shows the fallback)
	const dead = beltPage({
		policy: null,
		gateway: null,
		policyError: null,

		health: [],
		groups: null,
	});
	expect(
		(j(attr("klh-upstreams-card", dead)) as { groups: unknown }).groups,
	).toBeNull();
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
		probes: [probe("swarm-8901", true)],
		source: "probes+registry",
	});
	const registry = j(attr("klh-registry-card", local)) as {
		rows: {
			name: string;
			scope: string;
			upstream: string;
			monitored: string;
		}[];
	};
	expect(registry.rows[0]).toEqual({
		name: "nas-hub",
		scope: "Remote upstream",
		upstream: "nas.example:7799",
		monitored: "Not monitored here",
	});
});
