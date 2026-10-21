// test/hubctl-exec.test.ts — W484.1.1: `exec` runs allowlisted read-only
// probes on a hub over the existing ssh path. Local fixture: fake docker/ssh
// bins log calls and answer with canned rows.
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

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-exec-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const calls = join(dir, "calls");
const deployDir = join(dir, "hub");
const stack = join(dir, "stack.json");

const docker = join(bin, "docker");
writeFileSync(
	docker,
	`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(process.env.TEST_CALLS, "docker " + args + "\\n");
if (args === "ps -a")
	console.log(JSON.stringify({ Service: "buckle", State: "running" }));
`,
);
chmodSync(docker, 0o755);

const ssh = join(bin, "ssh");
writeFileSync(
	ssh,
	`#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, "ssh " + argv.join("\\u001f") + "\\n");
if (String(argv.at(-1)).includes("docker ps -a"))
	console.log(JSON.stringify({ Service: "buckle", State: "running" }));
`,
);
chmodSync(ssh, 0o755);

writeFileSync(
	stack,
	JSON.stringify({
		version: "v1.0.0-w484",
		auth: { required: false },
		hubs: {
			w484: { host: "127.0.0.1", deploy: { dir: deployDir, docker } },
			w484r: {
				host: "127.0.0.1",
				deploy: { dir: deployDir, docker, ssh: "lane@hub.test" },
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

function hubctl(args: string[]): { code: number; out: string } {
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: baseEnv,
		},
	);
	return { code: r.exitCode, out: stdoutAndStderr(r) };
}

function stdoutAndStderr(r: { stdout: Buffer; stderr: Buffer }): string {
	return r.stdout.toString() + r.stderr.toString();
}

function callsText(): string {
	return readFileSync(calls, "utf8");
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("exec runs an allowlisted probe on a local hub", () => {
	writeFileSync(calls, "");
	const r = hubctl(["exec", "w484", "docker", "ps", "-a"]);
	expect(r.code).toBe(0);
	expect(callsText()).toContain("docker ps -a");
	expect(r.out).toContain("buckle");
});

test("exec refuses non-allowlisted binaries", () => {
	const r = hubctl(["exec", "w484", "rm", "-rf", "/"]);
	expect(r.code).toBe(2);
	expect(r.out).toContain("not allowlisted");
	expect(r.out).toContain("docker [");
});

test("exec refuses shell-metachar arguments", () => {
	const r = hubctl(["exec", "w484", "docker", "ps", "a;b"]);
	expect(r.code).toBe(2);
	expect(r.out).toContain("unsafe characters");
});

test("exec refuses non-read shapes on allowlisted binaries", () => {
	const r = hubctl(["exec", "w484", "docker", "rmi", "img"]);
	expect(r.code).toBe(2);
	expect(r.out).toContain("not an allowlisted read-only shape");
});

test("exec rides ssh as one argv element on ssh hubs", () => {
	writeFileSync(calls, "");
	const r = hubctl(["exec", "w484r", "docker", "ps", "-a"]);
	expect(r.code).toBe(0);
	const sshLine = callsText()
		.split("\n")
		.find((l) => l.startsWith("ssh "));
	expect(sshLine).toBeDefined();
	const argv = (sshLine ?? "").slice(4).split("\u001f");
	expect(argv.at(-1)).toBe(`${docker} ps -a`);
	expect(argv).toContain("BatchMode=yes");
});

test("exec with no command prints usage", () => {
	const r = hubctl(["exec", "w484"]);
	expect(r.code).toBe(2);
	expect(r.out).toContain("usage: hubctl exec");
});
