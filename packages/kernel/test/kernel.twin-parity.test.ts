// Twin-parity pins (W1254): kernel holds the PROMOTED copies of proven
// duplicates; these tests byte-pin kernel ≡ the current twin faces so any
// drift during the package-by-package migration fails loudly here. A face
// that MIGRATES (its package repoints to kernel and the twin is deleted)
// drops its block from this file in the same change.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { servicemon } from "../src/kernel.servicemon.module.ts";

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

	// W1475: belt hubs.ts imports the kernel face; suspenders keeps its twin.
	test("loopback ≡ suspenders loopback.ts", () => {
		expect(bytesOf(`${KERNEL}/kernel.loopback.module.ts`)).toBe(
			bytesOf("packages/suspenders/hooks/lib/loopback.ts"),
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

	// W1471: the one seam the parity pin normalizes away — the injected stamp
	// must see every wrapped response (observability face, throw, handler 4xx).
	test("servicemon routes every wrapped response through the injected stamp", async () => {
		const seen: string[] = [];
		const sm = servicemon({
			service: "w1471",
			port: 0,
			stamp: (res, f) => {
				seen.push(`${f.service}|${f.hop}|${f.refusal ?? ""}`);
				return res;
			},
		});
		const fetch = sm.fetch((req) => {
			if (new URL(req.url).pathname === "/boom") throw new Error("boom");
			return new Response("nope", { status: 404 });
		});
		const at = (path: string): Request =>
			new Request(`http://127.0.0.1${path}`);
		expect((await fetch(at("/status"))).status).toBe(200);
		expect((await fetch(at("/boom"))).status).toBe(500);
		expect((await fetch(at("/x"))).status).toBe(404);
		expect(seen).toEqual([
			"w1471|observability|",
			"w1471|observability|handler_throw",
			"w1471|observability|handler",
		]);
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
