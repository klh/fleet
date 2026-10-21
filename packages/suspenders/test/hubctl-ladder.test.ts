// test/hubctl-ladder.test.ts — W688.7.1: the hub's real upstream ladder +
// enterprise entrypoint are machine config (stack.yaml), materialized by
// hubctl: render carries the entry/egress knobs, push writes the ladder file
// and builds the 0600 upstream.env ON the hub from key-file PATHS.
import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-ladder-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const deployDir = join(dir, "hub");
const keyFile = join(dir, "engine.key");
writeFileSync(keyFile, "sk-fixture-ladder-key\n");
mkdirSync(deployDir);
const stack = join(dir, "stack.json");
writeFileSync(
	stack,
	JSON.stringify({
		version: "v9-w6887",
		hubs: {
			ent: {
				host: "127.0.0.1",
				buckle_entry: "../buckle-overlay/src/server.ts",
				http_upstream_hosts: ["engine.example"],
				ready_model: "claude-haiku-4-5",
				deploy: { dir: deployDir },
				buckle_prefs: { allow_cloud: true, cost_speed: "quality" },
				secrets: { upstream_keys: { LITELLM_KEY: keyFile } },
				upstreams: {
					groups: {
						"claude-haiku-4-5": [
							{
								url: "http://engine.example:4100",
								dialect: "anthropic",
								api_key_env: "LITELLM_KEY",
							},
						],
					},
				},
			},
			solo: { host: "127.0.0.1", deploy: { dir: deployDir } },
		},
	}),
);

function hubctl(verb: string, hub: string) {
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), verb, hub],
		{
			env: { ...process.env, KLH_STACK: stack },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test("render carries the enterprise entry + egress knobs; solo emits none", () => {
	const ent = hubctl("render", "ent");
	expect(ent.code).toBe(0);
	expect(ent.out).toContain("HUB_BUCKLE_ENTRY=../buckle-overlay/src/server.ts");
	expect(ent.out).toContain("HUB_HTTP_UPSTREAM_HOSTS=engine.example");
	expect(ent.out).toContain("HUB_READY_MODEL=claude-haiku-4-5");
	const solo = hubctl("render", "solo");
	expect(solo.out).not.toContain("HUB_BUCKLE_ENTRY");
	expect(solo.out).not.toContain("HUB_HTTP_UPSTREAM_HOSTS");
	expect(solo.out).not.toContain("sk-fixture");
});

test("hub Buckle stamps its profile identity on relayed requests", () => {
	const template = readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: checking compose interpolation verbatim
	expect(template).toContain("BUCKLE_HUB_ID: ${HUB_NAME:-desktop}");
});

test("push writes the ladder file and a 0600 upstream.env built on-device", () => {
	const r = hubctl("push", "ent");
	expect(r.code).toBe(0);
	const ladder = parse(
		readFileSync(join(deployDir, "upstreams.hub.yaml"), "utf8"),
	);
	expect(ladder.groups["claude-haiku-4-5"][0].api_key_env).toBe("LITELLM_KEY");
	expect(JSON.stringify(ladder)).not.toContain("sk-fixture");
	const envPath = join(deployDir, "upstream.env");
	expect(readFileSync(envPath, "utf8")).toBe(
		"LITELLM_KEY=sk-fixture-ladder-key\n",
	);
	expect(statSync(envPath).mode & 0o777).toBe(0o600);
	expect(statSync(join(deployDir, ".env")).mode & 0o777).toBe(0o600);
	// W983: the owner-prefs file rides the declared buckle_prefs (0600, the
	// loadPrefs shape) — cloud open, quality mode
	const prefs = JSON.parse(
		readFileSync(join(deployDir, "buckle-prefs.json"), "utf8"),
	);
	expect(prefs).toEqual({ allow_cloud: true, cost_speed: "quality" });
	expect(statSync(join(deployDir, "buckle-prefs.json")).mode & 0o777).toBe(
		0o600,
	);
	// the key never rides the rendered .env
	expect(readFileSync(join(deployDir, ".env"), "utf8")).not.toContain(
		"sk-fixture",
	);
});

test("render hides Git origin credentials while pushed env stays private", () => {
	const privateStack = join(dir, "private-stack.json");
	const privateDir = join(dir, "private-hub");
	writeFileSync(
		privateStack,
		JSON.stringify({
			version: "v9-w6887",
			hubs: {
				private: {
					host: "127.0.0.1",
					deploy: { dir: privateDir },
					repos: {
						buckle: "https://user:fixture-secret@git.example/fleet.git",
						ref: "v9-w6887",
					},
				},
			},
		}),
	);
	const run = (verb: string) =>
		Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../deploy/hubctl.ts"),
				verb,
				"private",
			],
			{
				env: { ...process.env, KLH_STACK: privateStack },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	const rendered = run("render");
	expect(rendered.exitCode).toBe(0);
	expect(rendered.stdout.toString()).not.toContain("fixture-secret");
	expect(rendered.stdout.toString()).toContain("credentials redacted");
	expect(run("push").exitCode).toBe(0);
	expect(readFileSync(join(privateDir, ".env"), "utf8")).toContain(
		"fixture-secret",
	);
	expect(statSync(join(privateDir, ".env")).mode & 0o777).toBe(0o600);
});

test("solo push renders an empty ladder + empty upstream.env (compose stays valid)", () => {
	expect(hubctl("push", "solo").code).toBe(0);
	const ladder = parse(
		readFileSync(join(deployDir, "upstreams.hub.yaml"), "utf8"),
	);
	expect(ladder.groups).toEqual({});
	// W1123: fail-forward — an unconfigured hub never inherits the committed
	// Mac local-swarm (:890x); Buckle sees an empty pool, not fake local rows.
	expect(ladder.inherit_defaults).toBe(false);
	expect(readFileSync(join(deployDir, "upstream.env"), "utf8")).toBe("");
	// W983: undeclared buckle_prefs → the conservative defaults
	expect(readFileSync(join(deployDir, "buckle-prefs.json"), "utf8")).toBe(
		'{"allow_cloud":false,"cost_speed":"balanced"}\n',
	);
});

test("rendered ladder stamps inherit_defaults false by default, true only on explicit opt-in (W1123)", () => {
	// explicit `upstreams.inherit_defaults: true` → the committed base may merge
	const optStack = join(dir, "opt-stack.json");
	writeFileSync(
		optStack,
		JSON.stringify({
			version: "v9-w6887",
			hubs: {
				opt: {
					host: "127.0.0.1",
					deploy: { dir: deployDir },
					upstreams: { inherit_defaults: true, groups: {} },
				},
			},
		}),
	);
	const r = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			"push",
			"opt",
		],
		{
			env: { ...process.env, KLH_STACK: optStack },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(r.exitCode).toBe(0);
	const opted = parse(
		readFileSync(join(deployDir, "upstreams.hub.yaml"), "utf8"),
	);
	expect(opted.inherit_defaults).toBe(true);
});

test("compose binds the prefs file at BUCKLE_PREFS (W983)", () => {
	const template = readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	expect(template).toContain("BUCKLE_PREFS: /etc/klh/buckle-prefs.json");
	expect(template).toContain(
		"./buckle-prefs.json:/etc/klh/buckle-prefs.json:ro",
	);
});

test("push refuses when a declared key file is missing — nothing half-written", () => {
	const bad = join(dir, "bad-stack.json");
	writeFileSync(
		bad,
		JSON.stringify({
			version: "v9-w6887",
			hubs: {
				x: {
					host: "127.0.0.1",
					deploy: { dir: deployDir },
					secrets: { upstream_keys: { LITELLM_KEY: join(dir, "absent.key") } },
				},
			},
		}),
	);
	const r = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			"push",
			"x",
		],
		{ env: { ...process.env, KLH_STACK: bad }, stdout: "pipe", stderr: "pipe" },
	);
	expect(r.exitCode).not.toBe(0);
});
