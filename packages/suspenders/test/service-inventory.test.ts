import { expect, test } from "bun:test";
import { registryEntries } from "../../belt/bin/registry.ts";
import {
	MODEL_INVENTORY,
	matchingRegistrations,
} from "../hooks/lib/service-inventory.ts";
import { RECOVERY_MAP } from "../hooks/lib/recovery-map.ts";
import { localPage } from "../hooks/bin/console-html.ts";

test("every canonical model has exactly one monitored endpoint", () => {
	expect(MODEL_INVENTORY.map((m) => m.port)).toEqual(
		registryEntries().map((m) => m.port),
	);
	const ports = Object.values(RECOVERY_MAP).flatMap((e) =>
		e.probe.kind === "http" ? [e.probe.port] : [],
	);
	for (const m of MODEL_INVENTORY)
		expect(ports.filter((p) => p === m.port)).toHaveLength(1);
});

test("registered local aliases join monitored row; remote upstream does not inherit health", () => {
	const services = [
		{
			name: "extract",
			port: 8902,
			created: "",
			upstream: "http://127.0.0.1:8902",
		},
		{
			name: "remote",
			port: 8902,
			created: "",
			upstream: "http://example.invalid:8902",
		},
	];
	expect(matchingRegistrations(8902, services).map((s) => s.name)).toEqual([
		"extract",
	]);
	const page = localPage({
		services,
		regPath: "registry.json",
		error: null,
		source: "probes+registry",
		probes: [
			{
				id: "swarm-8902",
				name: "extract model",
				port: 8902,
				up: true,
				state: "up",
				detail: "HTTP 200",
				probed_at: new Date().toISOString(),
			},
		],
	});
	expect(page.match(/<klh-service-row /g)).toHaveLength(1);
	expect(page).toContain("Registered as");
	expect(page).toContain("Not monitored here");
	expect(page).toContain("http://example.invalid:8902");
});
