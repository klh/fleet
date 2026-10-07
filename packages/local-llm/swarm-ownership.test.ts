import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Importing swarm executes its CLI. Inspect its lifecycle boundary without
// launching specialists, including when this regression runs on a quiet host.
test("MLX supervisor observes the cloud gateway without owning its lifecycle", () => {
	const source = readFileSync(new URL("./swarm.ts", import.meta.url), "utf8");
	expect(source).not.toContain("gatewaySupervisor");
	expect(source).not.toContain("ensureGateway");
	const gatewayObservation = source.match(
		/name: gateway\.name,[\s\S]*?okStatus: gateway\.okStatus,/,
	)?.[0];
	expect(gatewayObservation).toBeDefined();
	expect(gatewayObservation).toContain('kind: "gateway"');
	expect(gatewayObservation).toContain("owned: false");
	expect(gatewayObservation).toContain("probeHeaders: gateway.probeHeaders");
});
