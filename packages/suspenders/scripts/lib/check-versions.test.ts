// check-versions.test.ts — W1303.1.6: the P1 version guard. Fixtures are
// scratch repos under the OS tmpdir (NEVER inside the worktree — git -C
// resolves upward); the CLI contract rides the real repo read-only in
// check-versions-cli.test.ts.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersions } from "./check-versions.ts";

const manifest = (dir: string, json: object): void => {
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(json, null, "\t")}\n`,
	);
};

/** Root @ 2.0.0 + packages/alpha + packages/beta, both @ 2.0.0, no deps. */
const fixture = (
	opts: { alpha?: object; beta?: object; root?: object; empty?: boolean } = {},
): string => {
	const dir = mkdtempSync(join(tmpdir(), "w1303-1-6-versions-"));
	execFileSync("git", ["init", "-q", dir]);
	manifest(
		dir,
		opts.root ?? {
			name: "fleet",
			private: true,
			version: "2.0.0",
			workspaces: ["packages/*", "!packages/decant"],
		},
	);
	mkdirSync(join(dir, "packages", "alpha"), { recursive: true });
	mkdirSync(join(dir, "packages", "beta"), { recursive: true });
	manifest(
		join(dir, "packages", "alpha"),
		opts.alpha ?? { name: "@klh/alpha", version: "2.0.0" },
	);
	manifest(
		join(dir, "packages", "beta"),
		opts.beta ?? { name: "@klh/beta", version: "2.0.0" },
	);
	if (opts.empty === true) mkdirSync(join(dir, "packages", "empty"));
	return dir;
};

const codes = (dir: string, pkg?: string) =>
	checkVersions(dir, pkg).findings.map((f) => f.code);

describe("checkVersions — green path", () => {
	test("exact pins + one version + no root deps → ok", () => {
		const dir = fixture();
		const r = checkVersions(dir);
		expect(r.ok).toBe(true);
		expect(r.findings).toEqual([]);
		expect(r.manifests).toBe(3);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("checkVersions — pin exactness", () => {
	test("float caret spec flags bad-dep-spec", () => {
		const dir = fixture({
			alpha: {
				name: "@klh/alpha",
				version: "2.0.0",
				dependencies: { zod: "^4.0.0", ok: "1.2.3" },
			},
		});
		const r = checkVersions(dir);
		expect(r.ok).toBe(false);
		expect(r.findings).toEqual([
			{
				code: "bad-dep-spec",
				file: "packages/alpha/package.json",
				message:
					"dependencies: zod@^4.0.0 is not pinned exact MAJOR.MINOR.PATCH",
			},
		]);
		rmSync(dir, { recursive: true, force: true });
	});
	test("workspace:* on an @klh/* sibling flags bad-dep-spec", () => {
		const dir = fixture({
			alpha: {
				name: "@klh/alpha",
				version: "2.0.0",
				devDependencies: { "@klh/beta": "workspace:*" },
			},
		});
		expect(codes(dir)).toEqual(["bad-dep-spec"]);
		rmSync(dir, { recursive: true, force: true });
	});
	test("latest tag / range specs flag too", () => {
		const dir = fixture({
			beta: {
				name: "@klh/beta",
				version: "2.0.0",
				peerDependencies: { typescript: "latest" },
				optionalDependencies: { left: "~1.0.0" },
			},
		});
		expect(codes(dir)).toEqual(["bad-dep-spec", "bad-dep-spec"]);
		rmSync(dir, { recursive: true, force: true });
	});
	test("non-plain manifest version flags bad-version", () => {
		const dir = fixture({
			alpha: { name: "@klh/alpha", version: "2.0.0-rc.1" },
		});
		const r = checkVersions(dir);
		expect(r.findings.map((f) => f.code)).toEqual(["bad-version", "drift"]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("checkVersions — one-version agreement", () => {
	test("a drifted manifest flags drift naming the repo version", () => {
		const dir = fixture({
			beta: { name: "@klh/beta", version: "2.1.0" },
		});
		const r = checkVersions(dir);
		expect(r.ok).toBe(false);
		expect(r.findings).toEqual([
			{
				code: "drift",
				file: "packages/beta/package.json",
				message: "version 2.1.0 disagrees with the repo version 2.0.0",
			},
		]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("checkVersions — root manifest", () => {
	test("root dependencies flag root-deps (repo root is not a package)", () => {
		const dir = fixture({
			root: {
				name: "fleet",
				private: true,
				version: "2.0.0",
				workspaces: ["packages/*"],
				dependencies: { zod: "4.0.0" },
			},
		});
		const r = checkVersions(dir);
		expect(r.findings).toEqual([
			{
				code: "root-deps",
				file: "package.json",
				message:
					"root manifest declares dependencies — the repo root is not a package",
			},
		]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("checkVersions — workspace coverage", () => {
	test("a glob-covered dir without package.json flags missing-manifest", () => {
		const dir = fixture({ empty: true });
		const r = checkVersions(dir);
		expect(r.ok).toBe(false);
		expect(r.findings).toEqual([
			{
				code: "missing-manifest",
				file: "packages/empty/package.json",
				message:
					"workspaces globs cover packages/empty/ but it has no package.json",
			},
		]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("checkVersions — scoped runs", () => {
	test("one package's findings only; siblings stay out", () => {
		const dir = fixture({
			alpha: {
				name: "@klh/alpha",
				version: "2.0.0",
				dependencies: { zod: "^4.0.0" },
			},
			beta: { name: "@klh/beta", version: "3.0.0" },
		});
		const r = checkVersions(dir, "alpha");
		expect(r.ok).toBe(false);
		expect(r.manifests).toBe(1);
		expect(r.findings.map((f) => f.file)).toEqual([
			"packages/alpha/package.json",
		]);
		// beta's drift is not alpha's finding
		expect(r.findings.every((f) => f.code === "bad-dep-spec")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
	test("@klh/<name> alias resolves the same package", () => {
		const dir = fixture({
			alpha: {
				name: "@klh/alpha",
				version: "2.0.0",
				dependencies: { zod: "^4.0.0" },
			},
		});
		expect(checkVersions(dir, "@klh/alpha").findings.length).toBe(1);
		rmSync(dir, { recursive: true, force: true });
	});
	test("a clean scoped package is green while the repo is red", () => {
		const dir = fixture({
			alpha: {
				name: "@klh/alpha",
				version: "2.0.0",
				dependencies: { zod: "^4.0.0" },
			},
		});
		const r = checkVersions(dir, "beta");
		expect(r.ok).toBe(true);
		expect(r.findings).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});
	test("unknown package flags no-such-package only", () => {
		const dir = fixture({ empty: true });
		const r = checkVersions(dir, "gamma");
		expect(r.findings.map((f) => f.code)).toEqual(["no-such-package"]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("checkVersions — real repo (read-only probe)", () => {
	test("green where P1 conformance landed (suspenders), red where not", () => {
		const repo = join(import.meta.dir, "..", "..", "..", "..");
		const clean = checkVersions(repo, "suspenders");
		expect(clean.ok).toBe(true);
		const whole = checkVersions(repo);
		expect(whole.ok).toBe(false);
		// telemetry has no manifest yet (W1303.1.10 owns it)
		expect(
			whole.findings.some(
				(f) =>
					f.code === "missing-manifest" &&
					f.file === "packages/telemetry/package.json",
			),
		).toBe(true);
	});
});
