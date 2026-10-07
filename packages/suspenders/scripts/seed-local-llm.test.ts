import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BELT_CODE_FILES, convergeBeltCode } from "./seed-local-llm.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-seed-llm-"));
	const home = join(root, "home");
	const beltBin = join(root, "belt/bin");
	mkdirSync(home, { recursive: true });
	mkdirSync(beltBin, { recursive: true });
	// distinct byte patterns per file prove copy provenance
	for (const file of BELT_CODE_FILES)
		writeFileSync(join(beltBin, file), `// belt/bin ${file}\n`);
	return {
		root,
		home,
		beltBin,
		src: (file: string) => join(beltBin, file),
		dst: (file: string) => join(home, file),
	};
}

describe("W422.6.1 belt-owned runtime convergence", () => {
	test("stale copies converge with a before-refresh backup of the prior copy", () => {
		const f = fixture();
		try {
			writeFileSync(f.dst("registry-emit.ts"), "// pre-W507 stale copy\n");
			const result = convergeBeltCode(f.home, f.beltBin);
			expect(result.refreshed).toContain("registry-emit.ts");
			expect(result.seeded.sort()).toEqual(
				BELT_CODE_FILES.filter((f2) => f2 !== "registry-emit.ts").sort(),
			);
			expect(readFileSync(f.dst("registry-emit.ts"), "utf8")).toBe(
				`// belt/bin registry-emit.ts\n`,
			);
			expect(readFileSync(f.dst("registry-emit.ts.before-refresh"), "utf8")).toBe(
				"// pre-W507 stale copy\n",
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test("identical copies are reported current and left byte-identical (no backup churn)", () => {
		const f = fixture();
		try {
			convergeBeltCode(f.home, f.beltBin); // first pass seeds
			const result = convergeBeltCode(f.home, f.beltBin); // second pass converges
			expect(result.seeded).toEqual([]);
			expect(result.refreshed).toEqual([]);
			expect(result.current.sort()).toEqual([...BELT_CODE_FILES].sort());
			expect(existsSync(f.dst("registry-emit.ts.before-refresh"))).toBe(false);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test("a customized belt-owned copy is converged, not silently kept (the W422.6.1 bug)", () => {
		const f = fixture();
		try {
			// a pre-W465 home may hold a re-export twin or older code — convergence wins
			writeFileSync(f.dst("registry.ts"), 'export * from "../belt/bin/registry.ts";');
			const result = convergeBeltCode(f.home, f.beltBin);
			expect(result.refreshed).toContain("registry.ts");
			expect(readFileSync(f.dst("registry.ts"), "utf8")).toBe(
				`// belt/bin registry.ts\n`,
			);
			expect(
				readFileSync(f.dst("registry.ts.before-refresh"), "utf8"),
			).toBe('export * from "../belt/bin/registry.ts";');
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test("missing belt/bin source fails loudly, never half-seeds a broken home", () => {
		const f = fixture();
		try {
			rmSync(f.src("registry-emit.ts"));
			expect(() => convergeBeltCode(f.home, f.beltBin)).toThrow(
				/missing belt\/bin source/,
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test("tier manifest degrades to false when the runtime copy rejects tier (stale-home path)", async () => {
		const f = fixture();
		try {
			writeFileSync(
				f.dst("registry-emit.ts"),
				'if (import.meta.main) process.exit(1);\n',
			);
			const { emitTierManifest } = await import("./seed-local-llm.ts");
			expect(await emitTierManifest(f.home)).toBe(false);
			expect(existsSync(f.dst("tier.json"))).toBe(false);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});
});
