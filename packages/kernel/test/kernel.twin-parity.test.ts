// Twin-parity pins (W1254): kernel holds the PROMOTED copies of proven
// duplicates; these tests byte-pin kernel ≡ the current twin faces so any
// drift during the package-by-package migration fails loudly here. A face
// that MIGRATES (its package repoints to kernel and the twin is deleted)
// drops its block from this file in the same change.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const bytesOf = (rel: string): string =>
	readFileSync(join(repoRoot, rel), "utf8");

const KERNEL = "packages/kernel/src";

describe("kernel twin-parity (byte-equal promotion fidelity)", () => {
	test("exec ≡ suspenders run.ts", () => {
		expect(bytesOf(`${KERNEL}/kernel.exec.module.ts`)).toBe(
			bytesOf("packages/suspenders/hooks/lib/run.ts"),
		);
	});

	test("host-guard ≡ suspenders host-guard.ts", () => {
		expect(bytesOf(`${KERNEL}/kernel.host-guard.module.ts`)).toBe(
			bytesOf("packages/suspenders/hooks/lib/host-guard.ts"),
		);
	});

	// W1471: servicemon promoted with the citizenship stamp INJECTED (kernel
	// imports nothing in fleet). Below DEFAULT_BUCKETS the bytes are equal
	// once the twin's stampResponse( calls read opts.stamp( and the kernel's
	// one stamp-option block is removed — any other drift fails here.
	test("servicemon ≡ suspenders servicemon.ts (modulo the injected stamp)", () => {
		const STAMP_OPTION =
			"\t// W1471: the injected citizenship stamp — REQUIRED, never defaulted\n\tstamp: Stamp;\n";
		const body = (text: string): string =>
			text.slice(text.indexOf("export const DEFAULT_BUCKETS"));
		const kernel = body(bytesOf(`${KERNEL}/kernel.servicemon.module.ts`));
		const twin = body(
			bytesOf("packages/suspenders/hooks/lib/servicemon.ts"),
		).replaceAll("stampResponse(", "opts.stamp(");
		expect(kernel.includes(STAMP_OPTION)).toBe(true);
		expect(kernel.replace(STAMP_OPTION, "")).toBe(twin);
	});

	test("theme: 4-way byte-equal (kernel + suspenders + belt + local)", () => {
		const kernel = bytesOf(`${KERNEL}/kernel.theme.module.ts`);
		expect(kernel).toBe(bytesOf("packages/suspenders/hooks/lib/theme.ts"));
		expect(kernel).toBe(bytesOf("packages/belt/bin/klh-theme.ts"));
		expect(kernel).toBe(bytesOf("packages/local/bin/klh-theme.ts"));
	});

	test("kernel src imports nothing in fleet (node builtins only)", () => {
		for (const f of readdirSync(join(repoRoot, KERNEL))) {
			const text = bytesOf(`${KERNEL}/${f}`);
			const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
			const fleet = imports.filter(
				(spec) =>
					spec.startsWith(".") === false &&
					spec.startsWith("node:") === false &&
					spec.startsWith("bun:") === false,
			);
			expect(fleet).toEqual([]);
		}
	});
});
