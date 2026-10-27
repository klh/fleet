// check-versions-cli.test.ts — W1303.1.6: the version-guard verb's CLI
// contract (verb-kit parsing + exit codes). Runs the real script against
// the real repo — every case here is read-only (scoped green, whole-repo
// red, --json, usage errors); finding logic rides the fixture suite in
// scripts/lib/check-versions.test.ts.
import { describe, expect, test } from "bun:test";

const CLI = new URL("./check-versions.ts", import.meta.url).pathname;

const run = (args: string[]) => {
	const p = Bun.spawnSync([process.execPath, CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout ?? new Uint8Array()),
		err: new TextDecoder().decode(p.stderr ?? new Uint8Array()),
	};
};

describe("check-versions CLI (W1303.1.6)", () => {
	test("bare door = whole-repo check; red today, exit 1, findings listed", () => {
		const r = run([]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("manifest(s) scanned");
		expect(r.out).toContain("versions: FAILED");
	});

	test("scoped clean package exits 0 with OK", () => {
		const r = run(["check", "suspenders"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("package suspenders");
		expect(r.out).toContain("versions: OK");
	});

	test("scoped offending package exits 1 naming its findings", () => {
		const r = run(["check", "speedy"]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("packages/speedy/package.json");
		expect(r.out).toContain("versions: FAILED");
	});

	test("--json renders the report shape, exit follows ok", () => {
		const ok = run(["check", "kernel", "--json"]);
		expect(ok.code).toBe(0);
		const report = JSON.parse(ok.out) as {
			ok: boolean;
			findings: unknown[];
			manifests: number;
		};
		expect(report.ok).toBe(true);
		expect(report.findings).toEqual([]);
		expect(report.manifests).toBe(1);
		const bad = run(["--json"]);
		expect(bad.code).toBe(1);
		const whole = JSON.parse(bad.out) as { ok: boolean };
		expect(whole.ok).toBe(false);
	});

	test("unknown package exits 1 with the no-such-package finding", () => {
		const r = run(["check", "no-such-pkg"]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("no workspace manifest matches");
	});

	test("unknown verb dies with the registry list", () => {
		const r = run(["frobnicate"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("check-versions");
	});
});
