// test/hub-dataplane.e2e.ts — W2329: the hub dataplane face as config, a
// tagged @playwright/test spec (one-framework law). A hub profile that
// declares `dataplane:` enables the `dataplane` compose profile (the
// work-graph resource API container + its health probe sidecar, the
// knowledge-sink pattern; docs/design/dataplane-api.md). Config-over-code:
// undeclared = no dataplane service and a byte-clean solo render; declared
// knobs fall through to the template defaults. The face owns its port — it
// never rides the LLM gateway front door.
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

type Svc = Record<string, unknown> & {
	volumes?: unknown[];
	environment?: Record<string, string>;
	healthcheck?: { test: string[] };
	depends_on?: Record<string, { condition: string }>;
};

const compose = parse(
	readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	),
	{ merge: true, maxAliasCount: 500 },
) as { services: Record<string, Svc> };

test.describe("@unit W2329 — dataplane hub profile", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-hub-dataplane-"));

	function render(hub: Record<string, unknown>): string {
		const stack = join(dir, "stack.json");
		writeFileSync(
			stack,
			JSON.stringify({ version: "v-fixture-w2329", hubs: { nas: hub } }),
			{ mode: 0o600 },
		);
		const p = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../deploy/hubctl.ts"),
				"render",
				"nas",
			],
			{
				env: { ...process.env, KLH_STACK: stack },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(p.exitCode).toBe(0);
		return p.stdout.toString();
	}

	test.afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("declared dataplane block enables the face profile + ports", () => {
		const out = render({
			host: "127.0.0.1",
			dataplane: { port: 7804, health_port: 7805 },
		});
		expect(out).toContain("HUB_DATAPLANE_PORT=7804");
		expect(out).toContain("HUB_DATAPLANE_HEALTH_PORT=7805");
		expect(out).toContain("COMPOSE_PROFILES=dataplane");
	});

	test("undeclared dataplane keeps the solo posture byte-clean", () => {
		const out = render({ host: "127.0.0.1" });
		expect(out).not.toContain("HUB_DATAPLANE_PORT");
		expect(out).not.toContain("COMPOSE_PROFILES");
	});

	test("knowledge and dataplane combine into one profiles line", () => {
		const out = render({
			host: "127.0.0.1",
			knowledge: { port: 7802, health_port: 7803 },
			dataplane: { port: 7804, health_port: 7805 },
		});
		expect(out).toContain("COMPOSE_PROFILES=knowledge,dataplane");
	});

	test("face runs the real dataplane-api entry on the hub-state volume", () => {
		const api = compose.services["dataplane-api"];
		expect(api.profiles).toEqual(["dataplane"]);
		expect(String(api.command)).toContain(
			"suspenders/hooks/bin/dataplane-api.ts",
		);
		expect(api.network_mode).toBe("host");
		expect(api.volumes).toContain("hub-state:/state/hub-home");
		expect(api.environment.HOME).toBe("/state/hub-home");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: compose contract
		const portContract = "${HUB_DATAPLANE_PORT:-7804}";
		expect(api.environment.DATAPLANE_API_PORT).toBe(portContract);
		// W1141 posture: the hub stays credential-free; bksk_ keys arrive per
		// request as Bearer headers, never as container env.
		for (const [k] of Object.entries(api.environment))
			expect(k, "no credential env on the face").not.toMatch(
				/KEY|TOKEN|SECRET/,
			);
		// W264: the host allowlist rides the shared guard, not a new auth path.
		expect(api.environment.SUSPENDERS_ALLOWED_HOSTS).toBe(
			"${HUB_ALLOWED_HOSTS:-suspenders.local}",
		);
	});

	test("health rides the outside-process probe sidecar (owner law)", () => {
		const health = compose.services["dataplane-health"];
		expect(health.profiles).toEqual(["dataplane"]);
		expect(health.network_mode).toBe("host");
		expect(String(health.command)).toContain("/status");
		expect(String(health.command)).toContain("deploy/healthcheck/probe.ts");
		expect(health.environment.HOME).toBe("/tmp");
		expect(health.depends_on["dataplane-api"].condition).toBe(
			"service_started",
		);
		expect(health.healthcheck.test.join(" ")).toContain("/healthz");
		// sidecars never hold state
		expect(
			(health.volumes ?? []).some((v) => String(v).includes("-state")),
		).toBe(false);
	});
});
