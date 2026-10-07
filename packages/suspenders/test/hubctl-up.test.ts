// test/hubctl-up.test.ts — W422.6.2: `up` honors the pinned-version gate.
// The W422.6 incident: desktop hub composed up a stale pre-pin .env (no
// HUB_FLEET_REF) and crash-looped every container. Fix under test: `up` reads
// the hub's deployed .env, refuses a missing or mismatched HUB_FLEET_REF
// against the stack.yaml pin, and proceeds only with --force (warned). Local
// fixture: fake docker logs every call, the hub has no ssh target so the .env
// lives on disk where the tests rewrite it per case.
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

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-up-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const stack = join(dir, "stack.json");
const calls = join(dir, "calls");
const deployDir = join(dir, "hub");
const envPath = join(deployDir, ".env");
const PIN = "v1.2.3-w4226";

const docker = join(bin, "docker");
writeFileSync(
	docker,
	`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, args.join(" ") + "\\n");
if (args.at(-1) === "json")
	console.log(
		JSON.stringify({
			Service: "buckle",
			State: "running",
			Health: "healthy",
		}),
	);
`,
);
chmodSync(docker, 0o755);
writeFileSync(
	stack,
	JSON.stringify({
		version: PIN,
		auth: { required: false },
		hubs: {
			w4226: {
				host: "127.0.0.1",
				deploy: { dir: deployDir, docker },
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

function upRan(): boolean {
	return readFileSync(calls, "utf8").includes("up -d");
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

/** Reset the hub's deployed .env to a named state before a case. */
function seedEnv(ref?: string): void {
	mkdirSync(deployDir, { recursive: true });
	writeFileSync(
		envPath,
		ref === undefined
			? `HUB_NAME=w4226\nHUB_BUCKLE_PORT=14301\n`
			: `HUB_NAME=w4226\nHUB_FLEET_REF=${ref}\n`,
	);
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("up refuses the W422.6 poison: a pre-pin .env with no HUB_FLEET_REF", () => {
	resetCalls();
	seedEnv();
	const r = hubctl(["up", "w4226"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("hubctl up refused");
	expect(r.out).toContain("no HUB_FLEET_REF");
	expect(r.out).toContain(`hubctl push w4226`);
	expect(upRan()).toBe(false);
});

test("up refuses an env pinned to a different version than stack.yaml", () => {
	resetCalls();
	seedEnv("v0.9.0-stale");
	const r = hubctl(["up", "w4226"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("pins v0.9.0-stale but stack.yaml pins");
	expect(upRan()).toBe(false);
});

test("up --force proceeds on the stale env, warning loudly", () => {
	resetCalls();
	seedEnv("v0.9.0-stale");
	const r = hubctl(["up", "w4226", "--force"]);
	expect(r.code).toBe(0);
	expect(r.out).toContain("! up --force: proceeding on a stale env");
	expect(upRan()).toBe(true);
});

test("up passes when the env pin matches the stack version", () => {
	resetCalls();
	seedEnv(PIN);
	const r = hubctl(["up", "w4226"]);
	expect(r.code).toBe(0);
	expect(r.out).not.toContain("--force");
	expect(upRan()).toBe(true);
});

test("up refuses when the hub has no .env at all", () => {
	resetCalls();
	rmSync(envPath, { force: true });
	const r = hubctl(["up", "w4226"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("no HUB_FLEET_REF");
	expect(upRan()).toBe(false);
});

test("up refuses an unpinned stack version even with a pinned env", () => {
	resetCalls();
	seedEnv("v0.8.0-legacy");
	const unpinned = join(dir, "unpinned-stack.json");
	const config = JSON.parse(readFileSync(stack, "utf8"));
	delete config.version;
	writeFileSync(unpinned, JSON.stringify(config));
	const r = hubctl(["up", "w4226"], { KLH_STACK: unpinned });
	expect(r.code).toBe(1);
	expect(r.out).toContain("no pinned version");
	expect(upRan()).toBe(false);
});

test("usage documents the up --force escape hatch", () => {
	const r = hubctl(["deploy"]);
	expect(r.code).toBe(2);
	expect(r.out).toContain("up accepts --force");
});
