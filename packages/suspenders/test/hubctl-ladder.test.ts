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
				buckle_entry: "../buckle-remote/src/server.ts",
				http_upstream_hosts: ["engine.example"],
				ready_model: "claude-haiku-4-5",
				deploy: { dir: deployDir },
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
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			verb,
			hub,
		],
		{ env: { ...process.env, KLH_STACK: stack }, stdout: "pipe", stderr: "pipe" },
	);
	return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test("render carries the enterprise entry + egress knobs; solo emits none", () => {
	const ent = hubctl("render", "ent");
	expect(ent.code).toBe(0);
	expect(ent.out).toContain("HUB_BUCKLE_ENTRY=../buckle-remote/src/server.ts");
	expect(ent.out).toContain("HUB_HTTP_UPSTREAM_HOSTS=engine.example");
	expect(ent.out).toContain("HUB_READY_MODEL=claude-haiku-4-5");
	const solo = hubctl("render", "solo");
	expect(solo.out).not.toContain("HUB_BUCKLE_ENTRY");
	expect(solo.out).not.toContain("HUB_HTTP_UPSTREAM_HOSTS");
	expect(solo.out).not.toContain("sk-fixture");
});

test("push writes the ladder file and a 0600 upstream.env built on-device", () => {
	const r = hubctl("push", "ent");
	expect(r.code).toBe(0);
	const ladder = parse(readFileSync(join(deployDir, "upstreams.hub.yaml"), "utf8"));
	expect(ladder.groups["claude-haiku-4-5"][0].api_key_env).toBe("LITELLM_KEY");
	expect(JSON.stringify(ladder)).not.toContain("sk-fixture");
	const envPath = join(deployDir, "upstream.env");
	expect(readFileSync(envPath, "utf8")).toBe("LITELLM_KEY=sk-fixture-ladder-key\n");
	expect(statSync(envPath).mode & 0o777).toBe(0o600);
	// the key never rides the rendered .env
	expect(readFileSync(join(deployDir, ".env"), "utf8")).not.toContain("sk-fixture");
});

test("solo push renders an empty ladder + empty upstream.env (compose stays valid)", () => {
	expect(hubctl("push", "solo").code).toBe(0);
	const ladder = parse(readFileSync(join(deployDir, "upstreams.hub.yaml"), "utf8"));
	expect(ladder.groups).toEqual({});
	expect(readFileSync(join(deployDir, "upstream.env"), "utf8")).toBe("");
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
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), "push", "x"],
		{ env: { ...process.env, KLH_STACK: bad }, stdout: "pipe", stderr: "pipe" },
	);
	expect(r.exitCode).not.toBe(0);
});
