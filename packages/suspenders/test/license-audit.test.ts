// test/license-audit.test.ts — W828: the PolyForm noncommercial perimeter
// audit. Covers classification (allowlist, copyleft buckets, SPDX OR/AND
// duals, unknown/missing), the node_modules walk (isolated .bun store +
// hoisted + scoped + dedupe), vendored-banner verification, model-license
// rules (registry parse incl. the AUDIO_SERVICES trap), report composition,
// the pulse-face lines, and the accepted-violations baseline.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LicenseAuditDeps,
	classifyLicense,
	composeLicenseReport,
	EXTERNAL_SOURCES,
	loadAccepted,
	type LicenseReport,
	readLicenseLines,
	parseModelIds,
	PERMISSIVE,
	saveAccepted,
	violationKey,
	verifyVendorHeaders,
	walkLicenses,
} from "../hooks/lib/license-audit.ts";

const pkg = (
	dir: string,
	name: string,
	version: string,
	license: string | null,
): void => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			license === null ? { name, version } : { name, version, license },
		)}\n`,
	);
};
describe("license classification", () => {
	test("allowlist classes: permissive, copyleft, unknown", () => {
		for (const l of PERMISSIVE) expect(classifyLicense(l)).toBe("permissive");
		for (const l of [
			"GPL-3.0-only",
			"AGPL-3.0",
			"LGPL-2.1",
			"SSPL-1.0",
			"BSL-1.1",
			"Elastic License 2.0",
		])
			expect(classifyLicense(l)).toBe("copyleft");
		for (const l of [null, "", "SEE LICENSE IN LICENSE", "UNLICENSED", "WTFPL"])
			expect(classifyLicense(l)).toBe("unknown");
	});

	test("SPDX duals: OR takes the permissive leg; AND needs all legs", () => {
		expect(classifyLicense("(GPL-3.0-only OR MIT)")).toBe("permissive");
		expect(classifyLicense("MIT OR Apache-2.0")).toBe("permissive");
		expect(classifyLicense("(GPL-2.0+ OR MIT) AND ISC")).toBe("permissive");
		expect(classifyLicense("GPL-3.0-only OR AGPL-3.0")).toBe("copyleft");
		expect(classifyLicense("MIT AND ISC")).toBe("permissive");
	});
});

describe("node_modules walk", () => {
	test("walks .bun store + hoisted, dedupes, scopes, dotfiles", () => {
		const root = mkdtempSync(join(tmpdir(), "lic-walk-"));
		try {
			pkg(
				join(root, "node_modules/.bun/mit@1.0.0/node_modules/mit"),
				"mit",
				"1.0.0",
				"MIT",
			);
			pkg(
				join(root, "node_modules/.bun/gpl@2.0.0/node_modules/gpl"),
				"gpl-pkg",
				"2.0.0",
				"GPL-3.0-only",
			);
			pkg(
				join(root, "node_modules/.bun/scoped@1.0.0/node_modules/@scope/deep"),
				"@scope/deep",
				"1.0.0",
				"ISC",
			);
			pkg(join(root, "node_modules/mit"), "mit", "1.0.0", "MIT");
			pkg(join(root, "node_modules/huh"), "huh-pkg", "3.0.0", null);
			const rows = walkLicenses(root);
			expect(rows.filter((r) => r.name === "mit")).toHaveLength(1);
			const gpl = rows.find((r) => r.name === "gpl-pkg");
			expect(gpl?.cls).toBe("copyleft");
			expect(rows.find((r) => r.name === "@scope/deep")?.cls).toBe(
				"permissive",
			);
			expect(rows.find((r) => r.name === "huh-pkg")?.cls).toBe("unknown");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("vendored banners + model licenses", () => {
	test("verifyVendorHeaders flags a missing banner on a fixture root", () => {
		const root = mkdtempSync(join(tmpdir(), "lic-vendor-"));
		try {
			const rel = join("vendor", "lit.js");
			mkdirSync(join(root, "vendor"), { recursive: true });
			writeFileSync(join(root, rel), "// no banner here\n");
			const rows = verifyVendorHeaders(root, [
				{
					path: rel,
					license: "BSD-3-Clause",
					marker: "Vendored from the Lit monorepo",
				},
			]);
			expect(rows).toEqual([
				{ path: rel, license: "BSD-3-Clause", header: "missing" },
			]);
			writeFileSync(
				join(root, rel),
				"// Vendored from the Lit monorepo — BSD-3-Clause\n",
			);
			expect(
				verifyVendorHeaders(root, [
					{
						path: rel,
						license: "BSD-3-Clause",
						marker: "Vendored from the Lit monorepo",
					},
				])[0]?.header,
			).toBe("present");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("parseModelIds: port↔model pairing ignores portless model rows", () => {
		const text = [
			"port: 8901,",
			'model: "a/qwen",',
			"port: 8912,",
			'model: "x/kev-4b",',
			"];",
			'model: "eleven/multilingual",',
			'model: "scribe_v1",',
		].join("\n");
		const ids = parseModelIds(text);
		expect(ids).toEqual([
			{ port: 8901, model: "a/qwen" },
			{ port: 8912, model: "x/kev-4b" },
		]);
	});
});

describe("report + pulse face + baseline", () => {
	test("composeLicenseReport totals + external map", () => {
		const root = mkdtempSync(join(tmpdir(), "lic-rep-"));
		try {
			pkg(
				join(root, "node_modules/.bun/m@1.0.0/node_modules/m"),
				"m",
				"1.0.0",
				"MIT",
			);
			const deps: LicenseAuditDeps = {
				repo: root,
				models: () => [
					{ port: 8906, model: "mlx-community/Qwen3.5-9B-MLX-4bit" },
				],
				vendor: () => [{ path: "v", license: "MIT", header: "present" }],
				walk: (r) => walkLicenses(r),
			};
			const rep = composeLicenseReport(deps);
			expect(rep.totals.packages).toBe(1);
			expect(rep.totals.violations).toBe(0);
			expect(rep.totals.models).toEqual({ total: 1, flagged: 1 });
			expect(rep.external.map((e) => e.name)).toContain("chorus");
			expect(EXTERNAL_SOURCES[0]?.policy).toContain("ZERO code");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("readLicenseLines: headline + violations, stale = silent", () => {
		const now = 1_700_000_000_000;
		const rep: LicenseReport = {
			at: now,
			repo: "r",
			totals: {
				packages: 81,
				allowlisted: 80,
				violations: 1,
				vendor: { present: 8, total: 8 },
				models: { total: 7, flagged: 3 },
			},
			violations: [
				{
					name: "g",
					version: "1",
					license: "GPL-3.0",
					cls: "copyleft",
					reason: "x",
				},
			],
			vendored: [],
			models: [],
			external: [],
		};
		const p = join(tmpdir(), "lic-face.json");
		writeFileSync(p, JSON.stringify(rep));
		const lines = readLicenseLines(now, 8 * 86_400_000, p);
		expect(lines[0]).toContain("81 pkgs");
		expect(lines[0]).toContain("1 violation(s)");
		expect(lines[1]).toContain("g@1");
		const stale: LicenseReport = { ...rep, at: now - 61_000 };
		writeFileSync(p, JSON.stringify(stale));
		expect(readLicenseLines(now, 60_000, p)).toEqual([]);
	});

	test("accepted baseline round-trips through violationKey", () => {
		const p = join(tmpdir(), "lic-accepted.json");
		const keys = new Set([
			violationKey({
				name: "g",
				version: "1",
				license: "GPL-3.0",
				cls: "copyleft",
				reason: "x",
			}),
		]);
		saveAccepted(keys, p);
		expect(loadAccepted(p).has("g@1@copyleft")).toBe(true);
		expect(loadAccepted(join(tmpdir(), "absent.json")).size).toBe(0);
	});
});
