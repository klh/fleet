// test/hubctl-hub-credential.e2e.ts — W2321.1: `mint-hub-credential` mints
// the MACHINE's hub credential (the token hubs.json projects from
// hubs.<label>.token_file) with the scopes dispatch needs hub-side:
// admin:WRITE_ is the wedge this fixes — a cache-read registry token
// 403s POST /v1/admin/keys, so every hub-pinned lane mint fails closed
// (W463). Same local-fixture shape as hubctl-mint-lane-key.e2e.ts: fake
// curl answers the hub-side script (the REAL script text runs via
// /bin/sh), fake ssh proves the root key VALUE never rides the command.
import { expect, test } from "@playwright/test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_CREDENTIAL_SCOPES } from "../deploy/hub-credential.ts";
test.describe("@unit", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-hubcred-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const calls = join(dir, "calls");
	const rootPath = join(dir, "root.env");
	const ROOT = "rootkey0123456789abcdef";
	const MINTED = "bksk_minted_machine_hub_credential";

	writeFileSync(rootPath, `BUCKLE_ROOT_KEY=${ROOT}\n`);

	const curl = join(bin, "curl");
	writeFileSync(
		curl,
		`#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const di = argv.indexOf("-d");
const body = di >= 0 ? (argv[di + 1] ?? "") : "";
fs.appendFileSync(process.env.TEST_CALLS, "curl " + argv.join(" ") + " body=" + JSON.stringify(body) + "\\n");
console.log(JSON.stringify({ key_id: "kidhub", key: process.env.MINTED, scopes: ["buckle:admin:WRITE_", "buckle:spoke:READ_", "buckle:proxy:READ_"], expires_at: null }));
console.log("201");
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
console.log(JSON.stringify({ key_id: "kidhub", key: process.env.MINTED }));
console.log("201");
`,
	);
	chmodSync(ssh, 0o755);

	const deployDir = join(dir, "hub");
	const stack = join(dir, "stack.json");
	writeFileSync(
		stack,
		JSON.stringify({
			version: "v1.0.0-w2321",
			auth: { required: false },
			hubs: {
				w2321: {
					host: "127.0.0.1",
					buckle_port: 14321,
					secrets: { buckle_root_key: rootPath },
					deploy: { dir: deployDir },
				},
				w2321r: {
					host: "127.0.0.1",
					buckle_port: 14322,
					secrets: { buckle_root_key: rootPath },
					deploy: { dir: deployDir, ssh: "lane@hub.test" },
				},
				w2321n: { host: "127.0.0.1", deploy: { dir: deployDir } },
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
			{ stdout: "pipe", stderr: "pipe", env: baseEnv },
		);
		return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
	}

	function callsText(): string {
		return readFileSync(calls, "utf8");
	}

	test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("the scope set carries admin:WRITE_ plus the spoke/proxy read faces", () => {
		// the wedge fix: dispatch mints lane keys via POST /v1/admin/keys
		expect(HUB_CREDENTIAL_SCOPES).toContain("buckle:admin:WRITE_");
		// federation-peers manifest pull + model-health /v1/models catalog
		expect(HUB_CREDENTIAL_SCOPES).toContain("buckle:spoke:READ_");
		expect(HUB_CREDENTIAL_SCOPES).toContain("buckle:proxy:READ_");
		// the credential never carries proxy WRITE_ — lanes ride their own keys
		expect(HUB_CREDENTIAL_SCOPES).not.toContain("buckle:proxy:WRITE_");
	});

	test("mint-hub-credential lands the raw key in --out (0600), metadata only", () => {
		writeFileSync(calls, "");
		const out = join(dir, "machine-hub.key");
		const r = hubctl(["mint-hub-credential", "w2321", "--out", out]);
		expect(r.code).toBe(0);
		expect(r.out).not.toContain(MINTED);
		expect(r.out).toContain("kidhub");
		expect(r.out).toContain("expires_at=null");
		const st = statSync(out);
		expect(st.mode & 0o777).toBe(0o600);
		expect(readFileSync(out, "utf8")).toBe(`${MINTED}\n`);
		const body = callsText();
		expect(body).toContain('"name":"machine-hub-credential-w2321"');
		expect(body).toContain('"buckle:admin:WRITE_"');
		expect(body).toContain('"buckle:spoke:READ_"');
		expect(body).toContain('"buckle:proxy:READ_"');
		expect(body).not.toContain("expires_in_s");
		expect(body).toContain("/v1/admin/keys");
		// root credential used ON the hub, never printed
		expect(body).toContain(`Bearer ${ROOT}`);
		expect(r.out).not.toContain(ROOT);
	});

	test("mint-hub-credential refuses an existing --out target", () => {
		const out = join(dir, "exists.key");
		writeFileSync(out, "old\n");
		chmodSync(out, 0o600);
		const r = hubctl(["mint-hub-credential", "w2321", "--out", out]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("already exists");
		expect(readFileSync(out, "utf8")).toBe("old\n");
	});

	test("mint-hub-credential demands --out", () => {
		const r = hubctl(["mint-hub-credential", "w2321"]);
		expect(r.code).toBe(2);
		expect(r.out).toContain("usage: hubctl mint-hub-credential");
		expect(r.out).toContain("--out");
	});

	test("mint-hub-credential rides ssh; the root VALUE never leaves the Mac", () => {
		writeFileSync(calls, "");
		const out = join(dir, "remote.key");
		const r = hubctl(["mint-hub-credential", "w2321r", "--out", out]);
		expect(r.code).toBe(0);
		const sshLine = callsText()
			.split("\n")
			.find((l) => l.startsWith("ssh "));
		expect(sshLine).toBeDefined();
		const sshArgv = JSON.parse((sshLine ?? "").slice(4)) as string[];
		const cmd = sshArgv.at(-1) ?? "";
		expect(cmd).not.toContain(ROOT);
		expect(cmd).toContain("root.env");
		expect(cmd).toContain("/v1/admin/keys");
		const ranLocally = callsText()
			.split("\n")
			.some((l) => l.startsWith("curl "));
		expect(ranLocally).toBe(false);
	});

	test("mint-hub-credential refuses a hub with no buckle_port/secrets", () => {
		const out = join(dir, "never.key");
		const r = hubctl(["mint-hub-credential", "w2321n", "--out", out]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("needs buckle_port");
	});
});
