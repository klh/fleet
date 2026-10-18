// test/hubctl-mint-lane-key.test.ts — W484.1.1: `mint-lane-key` mints a
// short-lived bksk_ lane key ON the hub. Local fixture: the root credential
// lives in a fixture file; a fake curl answers the hub-side script; a fake
// ssh proves the root key VALUE never rides the ssh command (only its
// on-device file path does).
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

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-mint-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const calls = join(dir, "calls");
const rootPath = join(dir, "root.env");
const ROOT = "rootkey0123456789abcdef";
const MINTED = "bksk_minted_lane_key";

writeFileSync(rootPath, `BUCKLE_ROOT_KEY=${ROOT}\n`);

const curl = join(bin, "curl");
writeFileSync(
	curl,
	`#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, "curl " + argv.join(" ") + "\\n");
if (argv.join(" ").includes("laneB")) {
	console.log(JSON.stringify({ error: "buckle.auth_failed" }));
	console.log("401");
} else {
	console.log(JSON.stringify({ key_id: "kid1", key: process.env.MINTED, expires_at: "2026-10-19T00:00:00Z" }));
	console.log("201");
}
`,
);
chmodSync(curl, 0o755);

const ssh = join(bin, "ssh");
writeFileSync(
	ssh,
	`#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, "ssh " + JSON.stringify(argv) + "\\n");
console.log(JSON.stringify({ key_id: "kid2", key: process.env.MINTED }));
console.log("201");
`,
);
chmodSync(ssh, 0o755);

const deployDir = join(dir, "hub");
const emptyPath = join(dir, "empty.env");
const stack = join(dir, "stack.json");
writeFileSync(
	stack,
	JSON.stringify({
		version: "v1.0.0-w484",
		auth: { required: false },
		hubs: {
			w484: {
				host: "127.0.0.1",
				buckle_port: 14301,
				secrets: { buckle_root_key: rootPath },
				deploy: { dir: deployDir },
			},
			w484r: {
				host: "127.0.0.1",
				buckle_port: 14302,
				secrets: { buckle_root_key: rootPath },
				deploy: { dir: deployDir, ssh: "lane@hub.test" },
			},
			w484n: { host: "127.0.0.1", deploy: { dir: deployDir } },
			w484e: {
				host: "127.0.0.1",
				buckle_port: 14303,
				secrets: { buckle_root_key: emptyPath },
				deploy: { dir: deployDir },
			},
		},
	}),
);

const baseEnv: Record<string, string> = {
	...process.env,
	KLH_STACK: stack,
	PATH: `${bin}:${process.env.PATH ?? ""}`,
	TEST_CALLS: calls,
	MINTED,
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
	return {
		code: r.exitCode,
		out: r.stdout.toString() + r.stderr.toString(),
	};
}

function callsText(): string {
	return readFileSync(calls, "utf8");
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("mint-lane-key mints on a local hub, root key used not printed", () => {
	writeFileSync(calls, "");
	const r = hubctl(["mint-lane-key", "w484", "--sid", "laneA"]);
	expect(r.code).toBe(0);
	expect(r.out).toContain(MINTED);
	expect(r.out).toContain("kid1");
	expect(r.out).not.toContain(ROOT);
	expect(callsText()).toContain(`Bearer ${ROOT}`);
	expect(callsText()).toContain('"name":"laneA"');
	expect(callsText()).toContain('"scopes":["buckle:proxy:WRITE_"]');
});

test("mint-lane-key defaults ttl to 3600", () => {
	writeFileSync(calls, "");
	const r = hubctl(["mint-lane-key", "w484", "--sid", "laneA"]);
	expect(r.code).toBe(0);
	expect(callsText()).toContain('"expires_in_s":3600');
});

test("mint-lane-key refuses a missing or malformed --sid", () => {
	const r = hubctl(["mint-lane-key", "w484"]);
	expect(r.code).toBe(2);
	expect(r.out).toContain("usage: hubctl mint-lane-key");
	const r2 = hubctl(["mint-lane-key", "w484", "--sid", "../evil"]);
	expect(r2.code).toBe(2);
});

test("mint-lane-key refuses out-of-bounds ttl", () => {
	expect(hubctl(["mint-lane-key", "w484", "--sid", "l", "--ttl", "10"]).code).toBe(2);
	expect(
		hubctl(["mint-lane-key", "w484", "--sid", "l", "--ttl", "100000"]).code,
	).toBe(2);
	expect(
		hubctl(["mint-lane-key", "w484", "--sid", "l", "--ttl", "abc"]).code,
	).toBe(2);
});

test("mint-lane-key surfaces a rejected mint (non-2xx)", () => {
	writeFileSync(calls, "");
	const r = hubctl(["mint-lane-key", "w484", "--sid", "laneB"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("buckle.auth_failed");
});

test("mint-lane-key reports a missing root key honestly", () => {
	writeFileSync(emptyPath, "");
	const r = hubctl(["mint-lane-key", "w484e", "--sid", "laneC"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("hub root key missing");
});

test("mint-lane-key rides ssh; the root VALUE never leaves the Mac", () => {
	writeFileSync(calls, "");
	const r = hubctl(["mint-lane-key", "w484r", "--sid", "laneD"]);
	expect(r.code).toBe(0);
	const sshLine = callsText()
		.split("\n")
		.find((l) => l.startsWith("ssh "));
	expect(sshLine).toBeDefined();
	const sshArgv = JSON.parse(sshLine.slice(4)) as string[];
	const cmd = sshArgv.at(-1) ?? "";
	expect(cmd).not.toContain(ROOT);
	expect(cmd).toContain("root.env");
	expect(cmd).toContain("/v1/admin/keys");
	expect(cmd).toContain("Authorization: Bearer $K");
	const ranLocally = callsText()
		.split("\n")
		.some((l) => l.startsWith("curl "));
	expect(ranLocally).toBe(false);
});

test("mint-lane-key refuses a hub with no buckle_port/secrets", () => {
	const r = hubctl(["mint-lane-key", "w484n", "--sid", "laneE"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("needs buckle_port");
});
