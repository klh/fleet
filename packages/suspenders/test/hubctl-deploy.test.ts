// test/hubctl-deploy.test.ts — W363: the install-grade hub deploy chain.
// hubctl deploy (mint → push → up → status) against a local-hub fixture:
// fake docker/curl/openssl log every call, the .env renders from the stack
// fixture, the compose template lands byte-equal, outside-process probes gate
// the exit code — and install.sh --hub routes the full front into the chain.
import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-deploy-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const stack = join(dir, "stack.json");
const calls = join(dir, "calls");
const deployDir = join(dir, "hub");
const rootKeyPath = join(deployDir, "buckle/buckle.env");

const docker = join(bin, "docker");
writeFileSync(
	docker,
	`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, toLog() + "\\n");
function toLog(): string {
	return args.join(" ");
}
if (args.at(-1) === "json")
	console.log(
		JSON.stringify({
			Service: "buckle",
			State: "running",
			Health: process.env.TEST_PS_HEALTH ?? "healthy",
		}),
	);
`,
);

const curl = join(bin, "curl");
writeFileSync(
	curl,
	`#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.TEST_CALLS, process.argv.at(-1) + "\\n");
console.log(process.env.TEST_HTTP ?? "200");
`,
);
const openssl = join(bin, "openssl");
writeFileSync(
	openssl,
	`#!${process.execPath}
console.log(process.env.TEST_KEY ?? "a".repeat(64));
`,
);
for (const f of [docker, curl, openssl]) chmodSync(f, 0o755);
writeFileSync(
	stack,
	JSON.stringify({
		version: "v1.2.3-w363",
		auth: { required: false },
		hubs: {
			w363: {
				host: "127.0.0.1",
				buckle_port: 14301,
				board_port: 18301,
				store_port: 18302,
				belt_port: 18303,
				buckle_health_port: 14302,
				board_health_port: 18304,
				store_health_port: 18305,
				belt_health_port: 18306,
				allowed_hosts: ["w363.local"],
				services_json: join(deployDir, "services.json"),
				deploy: { dir: deployDir, docker },
				secrets: { buckle_root_key: rootKeyPath },
			},
		},
	}),
);
const baseEnv: Record<string, string> = {
	...process.env,
	KLH_STACK: stack,
	PATH: `${bin}:${process.env.PATH ?? ""}`,
	TEST_CALLS: calls,
};

function resetCalls(): void {
	writeFileSync(calls, "");
}

function hubctl(
	args: string[],
	overrides: Record<string, string> = {},
): { code: number; out: string } {
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...baseEnv, ...overrides },
		},
	);
	return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("deploy runs the full chain: mint → push → up → probes gate exit", () => {
	resetCalls();
	const r = hubctl(["deploy", "w363"]);
	expect(r.code).toBe(0);
	const log = readFileSync(calls, "utf8");
	expect(log).toContain("up -d");
	expect(log).toContain("ps --format json");
	for (const port of [14302, 18304, 18305, 18306])
		expect(log).toContain(`:${port}/healthz`);
	const env = readFileSync(join(deployDir, ".env"), "utf8");
	expect(env).toContain("HUB_NAME=w363");
	expect(env).toContain("HUB_BUCKLE_PORT=14301");
	expect(env).toContain("HUB_FLEET_REF=v1.2.3-w363");
	expect(env).toContain("HUB_BUCKLE_AUTH=off");
	expect(env).toContain(`HUB_BUCKLE_ENV_FILE=${rootKeyPath}`);
	expect(env).toContain("HUB_ALLOWED_HOSTS=w363.local");
	const tpl = readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	expect(readFileSync(join(deployDir, "hub-compose.yaml"), "utf8")).toBe(tpl);
	const key = readFileSync(rootKeyPath, "utf8");
	expect(key).toMatch(/^BUCKLE_ROOT_KEY=[0-9a-f]{64}$/m);
	expect(r.out).toContain("all healthy");
});

test("deploy fails closed when probes fail after up", () => {
	resetCalls();
	const r = hubctl(["deploy", "w363"], {
		TEST_HTTP: "502",
		TEST_PS_HEALTH: "unhealthy",
	});
	expect(r.code).toBe(1);
	expect(r.out).toContain("probe(s) failed after up");
	expect(readFileSync(calls, "utf8")).toContain("up -d");
});

test("mint is idempotent: an existing root key is kept, never re-minted", () => {
	resetCalls();
	const before = readFileSync(rootKeyPath, "utf8");
	const r2 = hubctl(["deploy", "w363"], { TEST_KEY: "f".repeat(64) });
	expect(r2.code).toBe(0);
	expect(readFileSync(rootKeyPath, "utf8")).toBe(before);
});

test("unknown hub names fail the deploy before anything runs", () => {
	resetCalls();
	const r = hubctl(["deploy", "hub-missing"]);
	expect(r.code).toBe(1);
	expect(readFileSync(calls, "utf8")).toBe("");
});

test("an unpinned deployment is refused before mint, push or up", () => {
	resetCalls();
	const unpinned = join(dir, "unpinned-stack.json");
	const config = JSON.parse(readFileSync(stack, "utf8"));
	delete config.version;
	writeFileSync(unpinned, JSON.stringify(config));
	const result = hubctl(["deploy", "w363"], { KLH_STACK: unpinned });
	expect(result.code).toBe(1);
	expect(result.out).toContain("requires a pinned stack version");
	expect(readFileSync(calls, "utf8")).toBe("");
});

test("install.sh --hub routes into the same chain and lands a healthy hub", () => {
	resetCalls();
	const r = Bun.spawnSync(
		["bash", join(import.meta.dir, "../install.sh"), "--hub", "w363"],
		{ stdout: "pipe", stderr: "pipe", env: { ...baseEnv } },
	);
	expect(r.exitCode).toBe(0);
	expect(r.stdout.toString()).toContain("all healthy");
	expect(readFileSync(calls, "utf8")).toContain("up -d");
});

test("install.sh --hub --dry-run renders the .env only, zero side effects", () => {
	resetCalls();
	const r = Bun.spawnSync(
		[
			"bash",
			join(import.meta.dir, "../install.sh"),
			"--hub",
			"w363",
			"--dry-run",
		],
		{ stdout: "pipe", stderr: "pipe", env: { ...baseEnv } },
	);
	expect(r.exitCode).toBe(0);
	expect(r.stdout.toString()).toContain("HUB_NAME=w363");
	expect(readFileSync(calls, "utf8")).not.toContain("up -d");
});

test("install.sh --hub without a name exits 2", () => {
	const r = Bun.spawnSync(
		["bash", join(import.meta.dir, "../install.sh"), "--hub"],
		{ stdout: "pipe", stderr: "pipe", env: { ...baseEnv } },
	);
	expect(r.exitCode).toBe(2);
	expect(r.stderr.toString()).toContain("needs a hub name");
});
