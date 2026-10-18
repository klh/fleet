import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkBaseWorkspaces, planBaseWorkspaces } from "../deploy/hub-deps.ts";

const roots: string[] = [];

const makeRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "hub-deps-"));
	roots.push(root);
	return root;
};

const setup = (root: string, pkgDir: string, manifest: string) => {
	const d = join(root, "node_modules/fleet/packages", pkgDir);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "package.json"), manifest);
};

afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("planBaseWorkspaces", () => {
	test("absent base-monorepo dep plans nothing", () => {
		expect(planBaseWorkspaces(makeRoot())).toEqual([]);
	});

	test("plans unscoped + scoped links; manifest-less dirs skipped", () => {
		const root = makeRoot();
		setup(root, "beta", '{"name":"beta"}');
		setup(root, "alpha", '{"name":"@klh/alpha"}');
		mkdirSync(join(root, "node_modules/fleet/packages/stray"));
		const names = planBaseWorkspaces(root)
			.map((l) => l.name)
			.sort();
		expect(names).toEqual(["@klh/alpha", "beta"]);
	});

	test("manifest without name throws", () => {
		const root = makeRoot();
		setup(root, "x", '{"version":"1.0.0"}');
		expect(() => planBaseWorkspaces(root)).toThrow(/has no "name"/);
	});

	test("malformed manifest throws naming the file", () => {
		const root = makeRoot();
		setup(root, "bad", "{not json");
		expect(() => planBaseWorkspaces(root)).toThrow(
			/malformed workspace manifest/,
		);
	});
});

describe("linkBaseWorkspaces", () => {
	test("applies unscoped + scoped links with correct targets", () => {
		const root = makeRoot();
		setup(root, "beta", '{"name":"beta"}');
		setup(root, "alpha", '{"name":"@klh/alpha"}');
		const applied = linkBaseWorkspaces(root);
		expect(applied.map((l) => l.name).sort()).toEqual(["@klh/alpha", "beta"]);
		expect(readlinkSync(join(root, "node_modules/beta"))).toBe(
			"fleet/packages/beta",
		);
		expect(readlinkSync(join(root, "node_modules/@klh/alpha"))).toBe(
			"../fleet/packages/alpha",
		);
	});

	test("malformed manifest throws before any link lands", () => {
		const root = makeRoot();
		setup(root, "good", '{"name":"good"}');
		setup(root, "bad", "{not json");
		expect(() => linkBaseWorkspaces(root)).toThrow(
			/malformed workspace manifest/,
		);
		expect(existsSync(join(root, "node_modules/good"))).toBe(false);
	});

	test("replaces a dangling link, keeps a real dir", () => {
		const root = makeRoot();
		setup(root, "beta", '{"name":"beta"}');
		setup(root, "gamma", '{"name":"gamma"}');
		symlinkSync("/nonexistent/target", join(root, "node_modules/beta"));
		mkdirSync(join(root, "node_modules/gamma"));
		const applied = linkBaseWorkspaces(root);
		expect(applied.map((l) => l.name).sort()).toEqual(["beta", "gamma"]);
		expect(readlinkSync(join(root, "node_modules/beta"))).toBe(
			"fleet/packages/beta",
		);
		expect(lstatSync(join(root, "node_modules/gamma")).isSymbolicLink()).toBe(
			false,
		);
	});
});

describe("main block", () => {
	test("boot root const is defined + used (W714 dropped it — ReferenceError at boot)", () => {
		const src = readFileSync(
			new URL("../deploy/hub-deps.ts", import.meta.url),
			"utf8",
		);
		expect(src).toContain('export const HUB_FLEET_ROOT = "/src/fleet"');
		expect(src).not.toMatch(/\bROOT\b/);
	});
});
