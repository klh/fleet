import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkP1, isPinned, type P1Finding } from "../scripts/check-p1.ts";
import { P1_PIN } from "../tests/helpers/p1-findings.pin.ts";

const root = resolve(import.meta.dir, "..");

const row = (over: Partial<P1Finding>): P1Finding => ({
	check: "pack",
	pkg: "suspenders",
	prefix:
		'unresolved-dep: node_modules/@klh/suspenders/scripts/build-vendor.ts: "acorn" does not resolve from the install',
	...over,
});

describe("check-p1 pin matcher", () => {
	test("a row excuses the finding its prefix names", () => {
		const f = row({});
		expect(P1_PIN.some((r) => isPinned(r, f))).toBe(true);
	});

	test("the W2173.3 typescript pin row is gone (exact 7.0.2 landed)", () => {
		expect(
			P1_PIN.some((r) => r.check === "versions" && r.pkg === "buckle"),
		).toBe(false);
	});

	test("a row does not excuse another package or check", () => {
		expect(
			P1_PIN.some((r) =>
				isPinned(r, row({ pkg: "belt", prefix: "unresolved-dep: nope" })),
			),
		).toBe(false);
	});

	test("every live versions+deps finding is pinned (shrink-only ratchet)", async () => {
		const report = await checkP1(root, { pack: false });
		expect(report.findings).toEqual([]);
	});

	test("the yaml phantom fix landed: declared in suspenders devDependencies", () => {
		const m = JSON.parse(
			readFileSync(resolve(root, "packages/suspenders/package.json"), "utf8"),
		) as { devDependencies?: Record<string, string> };
		expect(m.devDependencies?.yaml).toBe("2.9.1");
	});
});
