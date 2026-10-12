// test/w507-tier.test.ts — W507: the tier is an EMITTED manifest, not
// launchd env. Covers resolveTier precedence (env → manifest → full),
// residentSet following the manifest tier, the registry-emit `tier` emitter
// (hash-stable, warm_ports = residentSet), and llm-keepwarm reading
// warm_ports straight from the manifest (fail-safe = the ≤4GB set).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTierManifest } from "../bin/registry-emit.ts";
import { resolveTier, residentSet } from "../bin/registry.ts";

// run against a fixture manifest as THE machine tier config (env override
// cleared so the manifest actually resolves); env restored on exit
function withManifest<T>(doc: unknown, run: () => T): T {
	const dir = mkdtempSync(join(tmpdir(), "w507-tier-"));
	const path = join(dir, "tier.json");
	writeFileSync(path, JSON.stringify(doc));
	const prevManifest = process.env.BELT_TIER_MANIFEST;
	const prevTier = process.env.BELT_TIER;
	delete process.env.BELT_TIER;
	process.env.BELT_TIER_MANIFEST = path;
	try {
		return run();
	} finally {
		if (prevManifest === undefined) delete process.env.BELT_TIER_MANIFEST;
		else process.env.BELT_TIER_MANIFEST = prevManifest;
		if (prevTier === undefined) delete process.env.BELT_TIER;
		else process.env.BELT_TIER = prevTier;
	}
}

describe("tier manifest (W507)", () => {
	test("resolveTier: explicit env overrides the manifest", () => {
		withManifest({ tier: "minimal" }, () => {
			process.env.BELT_TIER = "full";
			expect(resolveTier()).toBe("full");
		});
	});

	test("resolveTier: manifest tier wins when env unset; bad/missing → full", () => {
		expect(withManifest({ tier: "minimal" }, resolveTier)).toBe("minimal");
		expect(withManifest({ tier: "bogus" }, resolveTier)).toBe("full");
		expect(withManifest("not json at all", resolveTier)).toBe("full");
	});

	test("residentSet follows the manifest tier", () => {
		const ports = (doc: unknown): number[] =>
			withManifest(doc, () => residentSet().map((s) => s.port));
		expect(ports({ tier: "minimal" })).toEqual([8902, 8913]);
		expect(ports({ tier: "full" })).toEqual([8901, 8902, 8903, 8913]);
	});

	test("emitter: tier + warm_ports follow the manifest, hash-stable", () => {
		const out = withManifest({ tier: "minimal" }, () => emitTierManifest());
		expect(out).toBe(
			withManifest({ tier: "minimal" }, () => emitTierManifest()),
		);
		const doc = JSON.parse(out) as {
			version: number;
			tier: string;
			warm_ports: number[];
		};
		expect(doc).toEqual({
			version: 1,
			tier: "minimal",
			warm_ports: [8902, 8913],
		});
	});

	test("emitter: missing manifest fails to full with the full warm set", () => {
		const prevManifest = process.env.BELT_TIER_MANIFEST;
		const prevTier = process.env.BELT_TIER;
		delete process.env.BELT_TIER;
		process.env.BELT_TIER_MANIFEST = "/tmp/w507-kein-manifest.json";
		try {
			const doc = JSON.parse(emitTierManifest()) as {
				tier: string;
				warm_ports: number[];
			};
			expect(doc.tier).toBe("full");
			expect(doc.warm_ports).toEqual([8901, 8902, 8903, 8913]);
		} finally {
			if (prevManifest === undefined) delete process.env.BELT_TIER_MANIFEST;
			else process.env.BELT_TIER_MANIFEST = prevManifest;
			if (prevTier === undefined) delete process.env.BELT_TIER;
			else process.env.BELT_TIER = prevTier;
		}
	});
});
