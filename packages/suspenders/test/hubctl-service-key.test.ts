// test/hubctl-service-key.test.ts — W1124.15: persistent hub service
// credentials stay distinct from expiring lane keys, and the install gate
// rejects dead configured keys with the hub's actual code. Local fixture:
// a fake curl answers the hub-side scripts (the REAL script text runs via
// /bin/sh — same wire the live hub sees); a fake ssh proves key material
// never rides the ssh command line.
import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyConfiguredServiceKey } from "../deploy/hubctl.ts";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-svc-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const calls = join(dir, "calls");
const ROOT = "rootkey0123456789abcdef";
const SVC_OK = "bksk_aaaa11";
const SVC_EXP = "bksk_bbbb22";
const SVC_REV = "bksk_cccc33";
const MINTED = "bksk_dddd44";

const rootPath = join(dir, "root.env");
writeFileSync(rootPath, `BUCKLE_ROOT_KEY=${ROOT}\n`);

// Key files the tests point --file at (0600 by law).
const keyDir = join(dir, "keys");
mkdirSync(keyDir);
function keyFile(name: string, content: string, mode: number): string {
	const p = join(keyDir, name);
	writeFileSync(p, content);
	chmodSync(p, mode);
	return p;
}
const bareOk = keyFile("bare.env", `${SVC_OK}\n`, 0o600);
const envOk = keyFile("single.env", `BUCKLE_SERVICE_KEY=${SVC_OK}\n`, 0o600);
const expEnv = keyFile("expired.env", `BUCKLE_SERVICE_KEY=${SVC_EXP}\n`, 0o600);
const revEnv = keyFile("revoked.env", `BUCKLE_SERVICE_KEY=${SVC_REV}\n`, 0o600);
const wideEnv = keyFile("wide.env", `${SVC_OK}\n`, 0o644);
// The spoke-env hazard: FIRST line is the ROOT key — never guessed.
const spokeEnv = keyFile(
	"spoke.env",
	`BUCKLE_ROOT_KEY=${ROOT}\nBUCKLE_SERVICE_DESKTOP=${SVC_OK}\n`,
	0o600,
);

// Fake curl — logs argv + stdin, answers by request shape. Mint requests
// (-d body, /v1/admin/keys) return the raw key ONCE; verify requests answer
// by the candidate value inside the stdin body.
const curl = join(bin, "curl");
writeFileSync(
	curl,
	`#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
// VERIFY_KEY_SCRIPT posts the candidate key as the -d ARGV (stdin is
// consumed by B=$(cat) before curl runs) — the stub reads THAT body.
const di = argv.indexOf("-d");
const body = di >= 0 ? (argv[di + 1] ?? "") : "";
fs.appendFileSync(process.env.TEST_CALLS, "curl " + argv.join(" ") + " body=" + JSON.stringify(body) + "\\n");
const url = argv.find((a) => a.startsWith("http")) ?? "";
if (url.endsWith("/v1/admin/keys/verify")) {
	if (body.includes(process.env.SVC_OK)) {
		console.log(JSON.stringify({ valid: true, key_id: "kid_ok", scopes: ["buckle:proxy:WRITE_"] }));
		console.log("200");
	} else if (body.includes(process.env.SVC_EXP)) {
		console.log(JSON.stringify({ valid: false, code: "buckle.key_expired" }));
		console.log("200");
	} else if (body.includes(process.env.SVC_REV)) {
		console.log(JSON.stringify({ valid: false, code: "buckle.key_revoked" }));
		console.log("200");
	} else {
		console.log(JSON.stringify({ valid: false, code: "buckle.invalid_key" }));
		console.log("200");
	}
} else {
	console.log(JSON.stringify({ key_id: "kid_svc", key: process.env.MINTED, name: "svcA", scopes: ["buckle:proxy:WRITE_"], expires_at: null }));
	console.log("201");
}
`,
);
chmodSync(curl, 0o755);

// Fake ssh — logs argv + stdin (body transport proof), answers valid.
const ssh = join(bin, "ssh");
writeFileSync(
	ssh,
	`#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.TEST_CALLS, "ssh " + JSON.stringify(argv) + " stdin=" + JSON.stringify(stdin) + "\\n");
console.log(JSON.stringify({ valid: true, key_id: "kid_ok", scopes: ["buckle:proxy:WRITE_"] }));
console.log("200");
`,
);
chmodSync(ssh, 0o755);

const deployDir = join(dir, "hub");
const stack = join(dir, "stack.json");
writeFileSync(
	stack,
	JSON.stringify({
		version: "v1.0.0-w112415",
		auth: { required: false },
		hubs: {
			wA: {
				host: "127.0.0.1",
				buckle_port: 14311,
				secrets: { buckle_root_key: rootPath },
				deploy: { dir: deployDir },
			},
			wR: {
				host: "127.0.0.1",
				buckle_port: 14312,
				secrets: { buckle_root_key: rootPath },
				deploy: { dir: deployDir, ssh: "lane@hub.test" },
			},
			wN: { host: "127.0.0.1", deploy: { dir: deployDir } },
		},
	}),
);

const baseEnv: Record<string, string> = {
	...process.env,
	KLH_STACK: stack,
	PATH: `${bin}:${process.env.PATH ?? ""}`,
	TEST_CALLS: calls,
	SVC_OK,
	SVC_EXP,
	SVC_REV,
	MINTED,
};

function hubctl(args: string[]): { code: number; out: string } {
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), ...args],
		{ stdout: "pipe", stderr: "pipe", env: baseEnv },
	);
	const out = r.stdout.toString() + r.stderr.toString();
	if (r.exitCode !== 0) console.log(`[hubctl ${args.join(" ")}] ${out.trim()}`);
	return { code: r.exitCode, out };
}

function callsText(): string {
	return readFileSync(calls, "utf8");
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ─── mint-service-key: persistent, --out 0600, metadata only ───

test("mint-service-key lands the raw key in --out (0600), stdout metadata only", () => {
	writeFileSync(calls, "");
	const out = join(keyDir, "minted.env");
	const r = hubctl(["mint-service-key", "wA", "--name", "svcA", "--out", out]);
	expect(r.code).toBe(0);
	// raw material NEVER on stdout — metadata only
	expect(r.out).not.toContain(MINTED);
	expect(r.out).toContain("kid_svc");
	expect(r.out).toContain("expires_at=null");
	expect(r.out).toContain(out);
	const st = statSync(out);
	expect(st.mode & 0o777).toBe(0o600);
	expect(readFileSync(out, "utf8")).toBe(`${MINTED}\n`);
	const body = callsText();
	expect(body).toContain('"name":"svcA"');
	expect(body).toContain('"scopes":["buckle:proxy:WRITE_"]');
	expect(body).not.toContain("expires_in_s");
	expect(body).toContain("/v1/admin/keys");
	// the ROOT credential: used ON the hub device (the script substitutes it
	// into the local exec) — never in hubctl's stdout
	expect(body).toContain(`Bearer ${ROOT}`);
	expect(r.out).not.toContain(ROOT);
});

test("mint-service-key refuses an existing --out target", () => {
	const out = join(keyDir, "exists.env");
	writeFileSync(out, "old\n");
	chmodSync(out, 0o600);
	const r = hubctl(["mint-service-key", "wA", "--name", "svcB", "--out", out]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("already exists");
	expect(readFileSync(out, "utf8")).toBe("old\n");
});

test("mint-service-key refuses a symlinked --out target", () => {
	const real = join(keyDir, "real.env");
	writeFileSync(real, "x\n");
	const link = join(keyDir, "link.env");
	rmSync(link, { force: true });
	symlinkSync(real, link);
	const r = hubctl(["mint-service-key", "wA", "--name", "svcC", "--out", link]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("already exists");
	expect(readFileSync(real, "utf8")).toBe("x\n");
});

test("mint-service-key demands --out and a safe name", () => {
	expect(hubctl(["mint-service-key", "wA", "--name", "svcD"]).code).toBe(2);
	expect(hubctl(["mint-service-key", "wA", "--out", "/tmp/x.env"]).code).toBe(
		2,
	);
	expect(
		hubctl([
			"mint-service-key",
			"wA",
			"--name",
			"../evil",
			"--out",
			"/tmp/x.env",
		]).code,
	).toBe(2);
});

test("mint-service-key refuses a hub with no buckle_port/secrets", () => {
	const out = join(keyDir, "never.env");
	const r = hubctl(["mint-service-key", "wN", "--name", "svcE", "--out", out]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("needs buckle_port");
	expect(existsSync(out)).toBe(false);
});

// ─── verify-key: the install gate against dead configured keys ───

test("verify-key accepts a valid bare-file credential", () => {
	writeFileSync(calls, "");
	const r = hubctl(["verify-key", "wA", "--file", bareOk]);
	expect(r.code).toBe(0);
	expect(r.out).toContain("kid_ok");
	expect(r.out).toContain("buckle:proxy:WRITE_");
	// key material never echoed
	expect(r.out).not.toContain(SVC_OK);
	expect(r.out).not.toContain(ROOT);
	// the ACTUAL posted body carried the candidate key; URL is the verify route
	const body = callsText();
	expect(body).toContain(`{\\"key\\":\\"${SVC_OK}\\"}`);
	expect(body).toContain("/v1/admin/keys/verify");
});

test("verify-key accepts a single-variable env file", () => {
	const r = hubctl(["verify-key", "wA", "--file", envOk]);
	expect(r.code).toBe(0);
	expect(r.out).toContain("kid_ok");
});

test("verify-key fails on an EXPIRED credential with the hub's actual code", () => {
	writeFileSync(calls, "");
	const r = hubctl(["verify-key", "wA", "--file", expEnv]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("buckle.key_expired");
	expect(r.out).toContain("EXPIRED on this hub");
	// actionable: the mint-and-install remediation, old identity stays
	expect(r.out).toContain("mint-service-key wA");
	expect(r.out).toContain("audit ledger");
	// the EXPIRED key was genuinely the one verified against the hub
	expect(callsText()).toContain(SVC_EXP);
	expect(r.out).not.toContain(SVC_EXP);
	expect(r.out).not.toContain(ROOT);
});

test("verify-key fails on a REVOKED credential with the hub's actual code", () => {
	const r = hubctl(["verify-key", "wA", "--file", revEnv]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("buckle.key_revoked");
	expect(r.out).not.toContain(SVC_REV);
});

test("verify-key fails on a key unknown to the hub", () => {
	// the ROOT value as candidate → invalid_key (and proves the root line of
	// a spoke env is never silently accepted as the service credential)
	writeFileSync(calls, "");
	const r = hubctl([
		"verify-key",
		"wA",
		"--file",
		keyFile("rootonly.env", `${ROOT}\n`, 0o600),
	]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("buckle.invalid_key");
	expect(r.out).toContain("not valid on this hub");
	expect(r.out).not.toContain(ROOT);
});

test("verify-key refuses to guess inside a multi-variable file", () => {
	writeFileSync(calls, "");
	const r = hubctl(["verify-key", "wA", "--file", spokeEnv]);
	expect(r.code).toBe(1);
	// names are safe to print, values are not
	expect(r.out).toContain("--env NAME");
	expect(r.out).toContain("BUCKLE_ROOT_KEY");
	expect(r.out).toContain("BUCKLE_SERVICE_DESKTOP");
	expect(r.out).not.toContain(SVC_OK);
	expect(r.out).not.toContain(ROOT);
	// nothing reached the hub at all
	expect(callsText()).toBe("");
});

test("verify-key selects the explicit --env NAME", () => {
	writeFileSync(calls, "");
	const r = hubctl([
		"verify-key",
		"wA",
		"--file",
		spokeEnv,
		"--env",
		"BUCKLE_SERVICE_DESKTOP",
	]);
	expect(r.code).toBe(0);
	expect(r.out).toContain("kid_ok");
	expect(r.out).not.toContain(ROOT);
	// the RIGHT line was selected: the POSTED candidate is SVC_OK's exact
	// body shape — had the ROOT line been guessed, it could never appear
	// (the only ROOT in the raw log is the hub-side curl's Authorization argv)
	expect(callsText()).toContain(`{\\"key\\":\\"${SVC_OK}\\"}`);
});

test("verify-key reports a missing --env NAME", () => {
	const r = hubctl(["verify-key", "wA", "--file", spokeEnv, "--env", "NOPE"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("no variable named NOPE");
});

test("verify-key enforces 0600 on the credential file", () => {
	writeFileSync(calls, "");
	const r = hubctl(["verify-key", "wA", "--file", wideEnv]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("must be 0600");
	// nothing reached the hub
	expect(callsText()).toBe("");
});

test("verify-key reports a missing file", () => {
	const r = hubctl(["verify-key", "wA", "--file", join(keyDir, "absent.env")]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("cannot read");
});

// ─── transport: the candidate key rides ssh STDIN, never the command line ───

test("verify-key over ssh: key material rides stdin, never argv", () => {
	writeFileSync(calls, "");
	const r = hubctl(["verify-key", "wR", "--file", bareOk]);
	expect(r.code).toBe(0);
	const sshLine = callsText()
		.split("\n")
		.find((l) => l.startsWith("ssh "));
	expect(sshLine).toBeDefined();
	const sshArgv = JSON.parse(
		(sshLine ?? "").slice(4, (sshLine ?? "").lastIndexOf(" stdin=")),
	) as string[];
	const cmd = sshArgv.at(-1) ?? "";
	// the script + file path + verify URL ride argv; the KEY VALUE never does
	expect(cmd).toContain("root.env");
	expect(cmd).toContain("/v1/admin/keys/verify");
	expect(cmd).not.toContain(SVC_OK);
	expect(cmd).not.toContain(ROOT);
	// the body rode ssh stdin
	expect(sshLine ?? "").toContain(SVC_OK);
	const ranCurlLocally = callsText()
		.split("\n")
		.some((l) => l.startsWith("curl "));
	expect(ranCurlLocally).toBe(false);
});

// ─── deploy gate: a full install validates the configured hub link ───

// The gate runs in-process: the hub-side script resolves curl from THIS
// process's PATH — the fake bin must be visible here too.
function withFakeBin<T>(fn: () => T): T {
	const saved: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		TEST_CALLS: process.env.TEST_CALLS,
		SVC_OK: process.env.SVC_OK,
		SVC_EXP: process.env.SVC_EXP,
		SVC_REV: process.env.SVC_REV,
		MINTED: process.env.MINTED,
	};
	process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
	process.env.TEST_CALLS = calls;
	// the fixture curl branches on the candidate values — the spawned runs
	// get them via baseEnv, the in-process gate needs them here too
	process.env.SVC_OK = SVC_OK;
	process.env.SVC_EXP = SVC_EXP;
	process.env.SVC_REV = SVC_REV;
	process.env.MINTED = MINTED;
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("deploy gate: undeclared key = nothing to check", () => {
	writeFileSync(calls, "");
	const hub = {
		host: "127.0.0.1",
		buckle_port: 14311,
		secrets: { buckle_root_key: rootPath },
		deploy: { dir: deployDir },
	};
	expect(withFakeBin(() => verifyConfiguredServiceKey(hub, "gateA"))).toBe(
		true,
	);
	expect(callsText()).toBe("");
});

test("deploy gate: declared+valid passes, declared+expired fails the install", () => {
	const validHub = {
		host: "127.0.0.1",
		buckle_port: 14311,
		secrets: { buckle_root_key: rootPath, buckle_service_key: envOk },
		deploy: { dir: deployDir },
	};
	expect(withFakeBin(() => verifyConfiguredServiceKey(validHub, "gateB"))).toBe(
		true,
	);
	const expiredHub = {
		host: "127.0.0.1",
		buckle_port: 14311,
		secrets: { buckle_root_key: rootPath, buckle_service_key: expEnv },
		deploy: { dir: deployDir },
	};
	expect(
		withFakeBin(() => verifyConfiguredServiceKey(expiredHub, "gateC")),
	).toBe(false);
});

test("deploy gate: expired evidence names the code, never the key value", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	};
	try {
		const expiredHub = {
			host: "127.0.0.1",
			buckle_port: 14311,
			secrets: {
				buckle_root_key: rootPath,
				buckle_service_key: expEnv,
				buckle_service_key_env: "BUCKLE_SERVICE_KEY",
			},
			deploy: { dir: deployDir },
		};
		expect(
			withFakeBin(() => verifyConfiguredServiceKey(expiredHub, "gateD")),
		).toBe(false);
	} finally {
		console.log = orig;
	}
	const joined = logs.join("\n");
	expect(joined).toContain("buckle.key_expired");
	expect(joined).toContain("deploy: gateD");
	expect(joined).not.toContain(SVC_EXP);
	expect(joined).not.toContain(ROOT);
});
