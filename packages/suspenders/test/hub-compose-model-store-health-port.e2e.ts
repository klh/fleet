import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// W2867: the model-store-health sidecar's --listen default and its own
// docker-internal HEALTHCHECK fetch default must agree on
// HUB_MODEL_STORE_HEALTH_PORT — a literal drift here means the sidecar
// serves on one port while docker checks another whenever the hub leaves
// the knob unset, flipping a healthy sidecar to reported-unhealthy.
test("model-store-health command and HEALTHCHECK share one default port", () => {
	const yaml = readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	const compose = Bun.YAML.parse(yaml, { merge: true }) as {
		services: Record<
			string,
			{ command?: string; healthcheck?: { test?: string[] } }
		>;
	};
	const svc = compose.services["model-store-health"];
	const listenDefault = svc.command?.match(
		/--listen \$\{HUB_MODEL_STORE_HEALTH_PORT:-(\d+)\}/,
	)?.[1];
	const checkDefault = svc.healthcheck?.test
		?.join(" ")
		.match(/HUB_MODEL_STORE_HEALTH_PORT \?\? "(\d+)"/)?.[1];
	expect(listenDefault).toBeTruthy();
	expect(checkDefault).toBe(listenDefault);
});
