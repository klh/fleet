// W701: hubctl ssh/scp legs carry -o ConnectTimeout + BatchMode so an
// unreachable hub fails fast. Fake ssh/scp record argv; one real-ssh case
// aims at an unroutable TEST-NET address with a 1s knob.
import { expect, test } from "./pw";
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

test.setTimeout(30_000);
const dir = mkdtempSync(join(tmpdir(), "fleet-hub-sshto-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const calls = join(dir, "calls");
const fake = (name: string): void => {
	const p = join(bin, name);
	writeFileSync(
		p,
		`#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.TEST_CALLS,"${name} "+process.argv.slice(2).join(" ")+"\\n");process.exit(255);\n`,
	);
	chmodSync(p, 0o755);
};
fake("ssh");
fake("scp");
const stackFor = (deploy: Record<string, unknown>): string => {
	const f = join(dir, `stack-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(
		f,
		JSON.stringify({ version: "v1.0.0", hubs: { h: { host: "hub.test", deploy } } }),
	);
	return f;
};
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

function hubctl(verb: string, stack: string, path = process.env.PATH) {
	writeFileSync(calls, "");
	const t0 = Date.now();
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), verb, "h"],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PATH: path,
				KLH_STACK: stack,
				TEST_CALLS: calls,
			},
		},
	);
	return {
		code: r.exitCode,
		ms: Date.now() - t0,
		calls: readFileSync(calls, "utf8"),
		err: r.stderr.toString(),
	};
}

test("ssh legs default to ConnectTimeout=10 + BatchMode=yes", () => {
	const p = hubctl(
		"push",
		stackFor({ ssh: "kk@hub.test", dir }),
		`${bin}:${process.env.PATH}`,
	);
	expect(p.code).not.toBe(0);
	expect(p.calls).toContain(
		"ssh -o ConnectTimeout=10 -o BatchMode=yes kk@hub.test mkdir -p",
	);
});

test("deploy.connect_timeout knob overrides the default", () => {
	const p = hubctl(
		"push",
		stackFor({ ssh: "kk@hub.test", dir, connect_timeout: 3 }),
		`${bin}:${process.env.PATH}`,
	);
	expect(p.calls).toContain("-o ConnectTimeout=3 -o BatchMode=yes");
	expect(p.calls).not.toContain("ConnectTimeout=10");
});

test("real ssh to an unroutable target fails fast under the knob", () => {
	const r = hubctl(
		"push",
		stackFor({ ssh: "kk@192.0.2.1", dir, connect_timeout: 1 }),
	);
	expect(r.code).not.toBe(0);
	expect(r.ms).toBeLessThan(15_000);
});
