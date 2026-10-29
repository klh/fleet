// check-versions-cli.test.ts — W1303.1.6: the version-guard verb's CLI
// contract (verb-kit parsing + exit codes). Runs the real script against
// the real repo — every case here is read-only (scoped green, whole-repo
// red, --json, usage errors); finding logic rides the fixture suite in
// scripts/lib/check-versions.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./check-versions.ts", import.meta.url).pathname;

const run = (args: string[], env: Record<string, string> = {}) => {
	const p = Bun.spawnSync([process.execPath, CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout ?? new Uint8Array()),
		err: new TextDecoder().decode(p.stderr ?? new Uint8Array()),
	};
};

describe("check-versions CLI (W1303.1.6)", () => {
	test("bare door = whole-repo check; green since W2173.3 closed the residue, exit 0", () => {
		const r = run([]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("manifest(s) scanned");
		expect(r.out).toContain("versions: OK");
	});

	test("scoped clean package exits 0 with OK", () => {
		const r = run(["check", "suspenders"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("package suspenders");
		expect(r.out).toContain("versions: OK");
	});

	test("scoped offending package exits 1 naming its findings", () => {
		// W2173.3 closed the repo's pins, so the real repo is green — the
		// red path drives the real script against a scratch fixture repo.
		const dir = mkdtempSync(join(tmpdir(), "w2173-3-cli-red-"));
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({
				name: "fleet",
				private: true,
				version: "2.0.0",
				workspaces: ["packages/*"],
			})}\n`,
		);
		mkdirSync(join(dir, "packages", "alpha"), { recursive: true });
		writeFileSync(
			join(dir, "packages", "alpha", "package.json"),
			`${JSON.stringify({
				name: "@klh/alpha",
				version: "2.0.0",
				dependencies: { zod: "^4.0.0" },
			})}\n`,
		);
		const r = run(["check", "alpha"], { CHECK_VERSIONS_REPO: dir });
		expect(r.code).toBe(1);
		expect(r.out).toContain("packages/alpha/package.json");
		expect(r.out).toContain("is not pinned exact MAJOR.MINOR.PATCH");
		expect(r.out).toContain("versions: FAILED");
		rmSync(dir, { recursive: true, force: true });
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
		const bad = run(["check", "no-such-pkg", "--json"]);
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
