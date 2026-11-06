import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parse } from "yaml";
import {
	assertDeployRefsExist,
	assertKnowledgeVersionShape,
	FK_ORIGIN,
	FLEET_ORIGIN,
	type RefProbe,
} from "../deploy/hub-ref-preflight.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import { tmpDir } from "./helpers/fixture-kit.ts";

// W2779.5: the fk hub deployment as config — knowledge.mode=fk retargets
// the knowledge compose profile at the PUBLIC fleet-knowledge repo pulled
// at the 4th pinned ref (knowledge_version), with the outside-process
// health sidecar (owner law) and the 0600 fk conf staged beside the
// compose. Config-over-code: undeclared mode = the fleet-local sink stands
// byte-unchanged (the seam doc's compatibility law).

const dir = tmpDir("hub-fk-sink-");
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Svc = Record<string, unknown> & {
	profiles?: string[];
	command?: unknown;
	working_dir?: string;
	network_mode?: string;
	volumes?: unknown[];
	environment?: Record<string, string>;
	depends_on?: Record<string, { condition: string }>;
	healthcheck?: { test: string[] };
};

const compose = parse(
	readFileSync(join(import.meta.dir, "../deploy/hub-compose.yaml"), "utf8"),
	{ merge: true, maxAliasCount: 500 },
) as { services: Record<string, Svc>; volumes: Record<string, unknown> };

function render(
	hub: Record<string, unknown>,
	stack: Record<string, unknown>,
): string {
	const path = join(dir, "stack.json");
	writeFileSync(path, JSON.stringify({ hubs: { nas: hub }, ...stack }), {
		mode: 0o600,
	});
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			"render",
			"nas",
		],
		{
			env: { ...process.env, KLH_STACK: path },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (p.exitCode !== 0)
		throw new Error(`render failed: ${p.stderr.toString()}`);
	return p.stdout.toString();
}

const fkHub = {
	host: "127.0.0.1",
	knowledge: {
		mode: "fk",
		port: 7802,
		health_port: 7803,
		conf: "/volume1/docker/hub/fk-conf.json",
	},
};

test("fk mode renders the 4th pin + fk knobs; per-hub override wins", () => {
	const out = render(fkHub, {
		version: "v-fixture",
		knowledge_version: "fk-2026-11-06",
	});
	expect(out).toContain("HUB_KNOWLEDGE_MODE=fk");
	expect(out).toContain("HUB_KNOWLEDGE_VERSION=fk-2026-11-06");
	expect(out).toContain("COMPOSE_PROFILES=knowledge-fk");
	// the conf PATH on the hub renders (hubctl push stages it 0600)
	expect(out).toContain("HUB_KNOWLEDGE_CONF=/volume1/docker/hub/fk-conf.json");

	const override = render(
		{ ...fkHub, knowledge: { ...fkHub.knowledge, version: "fk-canary" } },
		{ version: "v-fixture", knowledge_version: "fk-2026-11-06" },
	);
	expect(override).toContain("HUB_KNOWLEDGE_VERSION=fk-canary");
});

test("undeclared mode keeps the fleet-local sink render byte-clean", () => {
	const out = render(
		{ host: "127.0.0.1", knowledge: { port: 7802, health_port: 7803 } },
		{ version: "v-fixture", knowledge_version: "fk-2026-11-06" },
	);
	expect(out).not.toContain("HUB_KNOWLEDGE_MODE");
	expect(out).not.toContain("HUB_KNOWLEDGE_VERSION");
});

test("fk mode with no pin anywhere refuses render (one-version law)", () => {
	expect(() => render(fkHub, { version: "v-fixture" })).toThrow(
		/pinned fleet-knowledge ref/,
	);
});

test("branch fk pin refuses render", () => {
	expect(() =>
		render(
			{ ...fkHub, knowledge: { ...fkHub.knowledge, version: "main" } },
			{ version: "v-fixture" },
		),
	).toThrow(/never main/);
});

test("fk-sink service: pinned-repo mount, fk entrypoint, no SUSPENDERS_* env", () => {
	const sink = compose.services["fk-sink"];
	// the profile SPLIT (not [knowledge]): fk and fleet-local sinks both
	// default to :7802/:7803 — one hub runs exactly ONE sink family
	expect(sink.profiles).toEqual(["knowledge-fk"]);
	expect(sink.working_dir).toBe("/srv/fk");
	expect(String(sink.command)).toBe("bun src/knowledge/bin/knowledge-api.ts");
	expect(sink.network_mode).toBe("host");
	expect(sink.volumes).toContain("fk-repo:/srv/fk:ro");
	expect(sink.volumes).toContain("fk-state:/state/fk");
	expect(sink.volumes).toContain("./fk-conf.json:/etc/klh/fk-conf.json:ro");
	expect(sink.environment.FLEET_KNOWLEDGE_CONFIG).toBe("/etc/klh/fk-conf.json");
	// seam law: fk never reads SUSPENDERS_* env
	for (const [k] of Object.entries(sink.environment))
		expect(k, "no SUSPENDERS_* env on fk-sink").not.toMatch(/^SUSPENDERS_/);
	// W1141 posture: no credential env either — write token + roll keys
	// live in the fk-state volume
	for (const [k] of Object.entries(sink.environment))
		expect(k, "no credential env on fk-sink").not.toMatch(/KEY|TOKEN|SECRET/);
	expect(sink.depends_on["fk-repo"].condition).toBe(
		"service_completed_successfully",
	);
});

test("fk-repo one-shot: git pull at the pin, skips when mode off", () => {
	const repo = compose.services["fk-repo"];
	expect(repo.profiles).toEqual(["knowledge-fk"]);
	const cmd = String(repo.command[0]);
	expect(cmd).toContain("git -C /srv/fk fetch --depth 1 origin");
	expect(cmd).toContain("$HUB_KNOWLEDGE_VERSION");
	// the mode guard: a fleet-mode knowledge hub pulls nothing
	expect(cmd.startsWith('if [ "$HUB_KNOWLEDGE_MODE" != "fk" ]')).toBe(true);
	// compose interpolation placeholder; the dollar is escaped so the lint sees no ${...}
	expect(repo.environment.HUB_FK_REPO_URL).toBe(
		"\x24{HUB_FK_REPO_URL:-https://github.com/icomdev/fleet-knowledge.git}",
	);
	// BUILD profile posture (W697): caps dropped, never a serving surface
	expect(repo.cap_drop).toEqual(["ALL"]);
	expect((repo.volumes ?? []).some((v) => String(v).includes("-state"))).toBe(
		false,
	);
});

test("fk-health sidecar: outside-process verdict, polls fk /health (owner law)", () => {
	const health = compose.services["fk-health"];
	expect(health.profiles).toEqual(["knowledge-fk"]);
	expect(health.network_mode).toBe("host");
	const cmd = String(health.command);
	expect(cmd).toContain("deploy/healthcheck/probe.ts");
	expect(cmd).toContain("/health");
	expect(cmd).not.toContain("/status");
	expect(health.depends_on["fk-sink"].condition).toBe("service_started");
	expect(health.environment.HOME).toBe("/tmp");
	expect(health.healthcheck.test.join(" ")).toContain("/healthz");
	// sidecars never hold state
	expect((health.volumes ?? []).some((v) => String(v).includes("-state"))).toBe(
		false,
	);
});

test("fk volumes declared; hub-init re-owns fk-state", () => {
	expect(compose.volumes["fk-repo"]).toBeDefined();
	expect(compose.volumes["fk-state"]).toBeDefined();
	const init = compose.services["hub-init"];
	expect(String(init.command[0])).toContain("/state/fk");
	expect(init.volumes).toContain("fk-state:/state/fk");
});

const served: RefProbe = () => ({
	status: 0,
	stdout: "89806009791d743bbfdf27c35d372ac1d7e0a3a7\trefs/tags/any\n",
	stderr: "",
});

test("activation preflight resolves the fk pin against the public fk origin", () => {
	const calls: string[][] = [];
	assertDeployRefsExist(
		{
			knowledge: { mode: "fk", version: "fk-tag", port: 7802 },
		} as unknown as HubProfile,
		"h",
		"v1",
		(argv) => {
			calls.push(argv);
			return served();
		},
	);
	// the fk leg rides alongside the stack version leg (its own origin)
	expect(calls).toEqual([
		["git", "ls-remote", "--exit-code", FLEET_ORIGIN, "v1"],
		["git", "ls-remote", "--exit-code", FK_ORIGIN, "fk-tag"],
	]);
});

test("a dead fk pin fails closed with the repin remedy", () => {
	expect(() =>
		assertDeployRefsExist(
			{
				knowledge: { mode: "fk", version: "fk-dead" },
			} as unknown as HubProfile,
			"zai",
			"v1",
			(argv) =>
				// the stack version resolves; only the fk leg is dead
				argv.includes("fk-dead")
					? { status: 2, stdout: "", stderr: "" }
					: served(),
		),
	).toThrow(/knowledge_version "fk-dead" does not exist in/);
});

test("shape gate: unpinned fk mode refuses before any probe", () => {
	let probes = 0;
	const probe: RefProbe = () => {
		probes++;
		return served();
	};
	expect(() =>
		assertDeployRefsExist(
			{ knowledge: { mode: "fk" } } as unknown as HubProfile,
			"zai",
			"v1",
			probe,
		),
	).toThrow(/pinned fleet-knowledge ref/);
	expect(probes).toBe(0);
	expect(() =>
		assertKnowledgeVersionShape({
			knowledge: { mode: "fk", version: "master" },
		} as unknown as HubProfile),
	).toThrow(/never main/);
});
