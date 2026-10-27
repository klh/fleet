import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpDir } from "./helpers/fixture-kit.ts";
import { join } from "node:path";
import { parse } from "yaml";

// W1217: the NAS knowledge sink as config — a hub profile that declares
// `knowledge:` enables the `knowledge` compose profile (the knowledge-api
// sink + its health probe sidecar). Config-over-code: undeclared = no sink
// service and a byte-identical solo render; declared knobs fall through to
// the template defaults. The sink face is the existing knowledge-api —
// W1213's /roll aggregation routes ride it once that branch integrates.

const dir = tmpDir("hub-knowledge-sink-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
type Svc = Record<string, unknown> & {
	volumes?: unknown[];
	environment?: Record<string, string>;
	healthcheck?: { test: string[] };
	depends_on?: Record<string, { condition: string }>;
};
const template = readFileSync(
	join(import.meta.dir, "../deploy/hub-compose.yaml"),
	"utf8",
);
const compose = parse(template, { merge: true }) as {
	services: Record<string, Svc>;
};

function render(hub: Record<string, unknown>): string {
	const stack = join(dir, "stack.json");
	writeFileSync(
		stack,
		JSON.stringify({ version: "v-fixture-w1217", hubs: { nas: hub } }),
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

test("declared knowledge block enables the sink profile + ports", () => {
	const out = render({
		host: "127.0.0.1",
		knowledge: { port: 7802, health_port: 7803 },
	});
	expect(out).toContain("HUB_KNOWLEDGE_SINK_PORT=7802");
	expect(out).toContain("HUB_KNOWLEDGE_SINK_HEALTH_PORT=7803");
	expect(out).toContain("COMPOSE_PROFILES=knowledge");
});

test("undeclared knowledge keeps the solo posture byte-clean", () => {
	const out = render({ host: "127.0.0.1" });
	expect(out).not.toContain("HUB_KNOWLEDGE_SINK_PORT");
	expect(out).not.toContain("COMPOSE_PROFILES");
});

test("belt_model and knowledge combine into one profiles line", () => {
	const out = render({
		host: "127.0.0.1",
		knowledge: { port: 7802, health_port: 7803 },
		belt_model: {
			port: 8914,
			health_port: 8915,
			upstream: "http://127.0.0.1:11434",
		},
	});
	expect(out).toContain("COMPOSE_PROFILES=belt-model,knowledge");
});

test("sink runs the real knowledge-api face on the hub-state volume", () => {
	const sink = compose.services["knowledge-sink"];
	expect(sink.profiles).toEqual(["knowledge"]);
	expect(String(sink.command)).toContain(
		"suspenders/hooks/bin/knowledge-api.ts",
	);
	expect(sink.network_mode).toBe("host");
	expect(sink.volumes).toContain("hub-state:/state/hub-home");
	expect(sink.environment.HOME).toBe("/state/hub-home");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: compose contract
	const portContract = "${HUB_KNOWLEDGE_SINK_PORT:-7802}";
	expect(sink.environment.KNOWLEDGE_API_PORT).toBe(portContract);
	// W1211/W1141 posture: the hub stays credential-free; the sink never gets
	// a key env — auth is the W1213 scoped roll key + the install write token.
	for (const [k] of Object.entries(sink.environment))
		expect(k, "no credential env on the sink").not.toMatch(/KEY|TOKEN|SECRET/);
});

test("health rides the outside-process probe sidecar (owner law)", () => {
	const health = compose.services["knowledge-health"];
	expect(health.profiles).toEqual(["knowledge"]);
	expect(health.network_mode).toBe("host");
	expect(String(health.command)).toContain("/status");
	expect(String(health.command)).toContain("deploy/healthcheck/probe.ts");
	expect(health.environment.HOME).toBe("/tmp");
	expect(health.depends_on["knowledge-sink"].condition).toBe("service_started");
	expect(health.healthcheck.test.join(" ")).toContain("/healthz");
	// sidecars never hold state
	expect((health.volumes ?? []).some((v) => String(v).includes("-state"))).toBe(
		false,
	);
});
