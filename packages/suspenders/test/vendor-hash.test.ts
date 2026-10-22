// vendor-hash.test.ts — W292 (W278 review finding #9): the committed vendored
// Lit bundles must byte-match a fresh production build (drift alarm), ship
// WITHOUT the dev-mode runtime ("Lit is in dev mode"), and share ONE lit
// runtime chunk instead of inlining lit per bundle. The fresh build reuses
// scripts/build-vendor.ts's argv verbatim (outdir swapped for a tmpdir) so
// the flags have one source of truth; the repo's vendor/ dir is never
// written by this test.
import { describe, expect, test } from "bun:test";
import {
	readdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ROOT = join(import.meta.dir, "..");
const VENDOR = join(ROOT, "hooks/board-html/vendor");

function sha256(b: Buffer): string {
	return createHash("sha256").update(b).digest("hex");
}

// The package.json face — bun scripts/build-vendor.ts — spawned verbatim
// with --outdir swapped for a throwaway tmpdir so the test never writes the
// repo's vendor/ dir. Banner + prune ride along (one face, no mirror).
function freshBuild(): Map<string, string> {
	const out = mkdtempSync(join(tmpdir(), "w292-vendor-"));
	try {
		const p = Bun.spawnSync(
			["bun", join(ROOT, "scripts/build-vendor.ts"), "--outdir", out],
			{
				cwd: ROOT,
				// bun's minifier names symbols differently per NODE_ENV class
				// (unset/production vs test/development) — pin the child so a
				// `bun test` run (NODE_ENV=test) still byte-matches committed
				// artifacts built the plain `bun run build:vendor` way.
				env: { ...process.env, NODE_ENV: "production" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(p.exitCode).toBe(0);
		const hashes = new Map<string, string>();
		for (const f of readdirSync(out).sort())
			hashes.set(f, sha256(readFileSync(join(out, f))));
		return hashes;
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

describe("vendor-hash (W292)", () => {
	test("build:vendor stays a production split build with a named lit chunk", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		const script: string = pkg.scripts["build:vendor"];
		expect(script).toBe("bun scripts/build-vendor.ts");
		// the pinned flags + entries live in the build face, not the
		// package.json line (W1107.2.2) — still one source of truth
		const src = readFileSync(join(ROOT, "scripts/build-vendor.ts"), "utf8");
		for (const token of [
			"--minify",
			"--production",
			"--splitting",
			"--chunk-naming",
			"lit-[hash].[ext]",
			"hooks/board-html/klh-components.ts",
			"hooks/board-html/klh-service-row.ts",
		])
			expect(src).toContain(token);
	});

	test("committed vendor artifacts byte-match a fresh production build", () => {
		const fresh = freshBuild();
		const committed = new Map<string, string>();
		for (const f of readdirSync(VENDOR).sort())
			committed.set(f, sha256(readFileSync(join(VENDOR, f))));
		expect([...fresh.keys()].filter((f) => !f.endsWith(".js"))).toEqual([]);
		expect([...fresh.keys()]).toEqual([...committed.keys()]);
		const drifted = [...fresh].filter(([f, h]) => committed.get(f) !== h);
		expect(drifted.map(([f]) => f)).toEqual([]);
	});

	test("artifacts ship production lit — no dev-mode runtime anywhere", () => {
		for (const f of readdirSync(VENDOR)) {
			const s = readFileSync(join(VENDOR, f), "utf8");
			expect(s).not.toContain("Lit is in dev mode");
		}
	});

	test("one shared lit runtime chunk; every entry imports it", () => {
		const importsOf = (f: string): string[] =>
			[
				...readFileSync(join(VENDOR, f), "utf8").matchAll(
					/from"\.\/(lit-[^"]+\.js)"/g,
				),
			].map((m) => m[1] ?? "");
		const entries = readdirSync(VENDOR).filter(
			(f) => f.endsWith(".js") && !f.startsWith("lit-"),
		);
		// hash-named chunks are fine; the >1KB runtime must be shared by all
		const shared = entries
			.map((f) => importsOf(f))
			.reduce((a, b) => a.filter((c) => b.includes(c)))
			.filter((c) => statSync(join(VENDOR, c)).size > 1024);
		expect(shared).toHaveLength(1);
	});
});
